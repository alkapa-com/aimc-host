import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { PACKAGE_NAME } from "./version.ts";

// The agent as a Windows "service": a Task Scheduler task that runs `aimc-host start --service`
// as you when you log in. That starts a hidden supervisor (its console window flashes for a
// moment) and ends; the supervisor runs the agent, writes its output to agent.log in the
// settings folder, and starts it again after a crash (like systemd's Restart=on-failure).
//
// Why at log-in and not at boot ("whether logged in or not"): Ollama on Windows runs while you
// are logged in, and Windows can't run such tasks for Microsoft Entra ID (work) accounts. A task
// for your own account needs no administrator rights; if a policy forbids it anyway, the agent
// says to use an administrator terminal.

export const TASK_NAME = "aimc-host";

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string, args: string[], env?: Record<string, string>) => ExecResult;

export const exec: Exec = (cmd, args, env) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, env: env ? { ...process.env, ...env } : process.env, timeout: 60_000 });
  if (r.error) return { status: null, stdout: "", stderr: r.error.message };
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** Windows said no for lack of rights: the command must run in an administrator terminal. */
export class AdminRequiredError extends Error {
  constructor(command: string) {
    super(
      `Windows refused: \`${command}\` needs administrator rights here. Open PowerShell or Terminal with "Run as administrator" (right-click it) and run: ${PACKAGE_NAME} ${command}`,
    );
    this.name = "AdminRequiredError";
  }
}

export function isAccessDenied(r: ExecResult): boolean {
  return /access is denied|0x80070005|E_ACCESSDENIED|UnauthorizedAccess|PermissionDenied/i.test(`${r.stdout}\n${r.stderr}`);
}

export interface TaskInputs {
  nodePath: string;
  cliPath: string;
  /** The folder with your settings: the task's working directory. */
  workDir: string;
}

/** The task's command line arguments (after node.exe). */
export function taskArguments({ cliPath }: TaskInputs): string {
  return `"${cliPath}" start --service`;
}

/**
 * The PowerShell that registers the task. Values come in as environment variables, so no path
 * needs quoting inside the script.
 */
export const REGISTER_SCRIPT = `$ErrorActionPreference = 'Stop'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $env:AIMC_NODE -Argument $env:AIMC_ARGS -WorkingDirectory $env:AIMC_WORKDIR
$atLogOn = New-ScheduledTaskTrigger -AtLogOn -User $user
$atLogOn.Delay = 'PT30S'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $env:AIMC_TASK -Description $env:AIMC_DESC -Action $action -Trigger $atLogOn -Settings $settings -Principal $principal -Force | Out-Null
`;

/** Which Windows account this terminal runs as (DOMAIN\\user): the task runs as it. */
export function currentUser(run: Exec = exec): string {
  const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().Name"]);
  return r.stdout.trim() || process.env.USERNAME || "this user";
}

export function registerTask(inputs: TaskInputs, run: Exec = exec): void {
  const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", REGISTER_SCRIPT], {
    AIMC_NODE: inputs.nodePath,
    AIMC_ARGS: taskArguments(inputs),
    AIMC_WORKDIR: inputs.workDir,
    AIMC_TASK: TASK_NAME,
    AIMC_DESC: `${PACKAGE_NAME}: lends this GPU to an aimc server. Written by \`${PACKAGE_NAME} install-service\`; remove it with \`${PACKAGE_NAME} uninstall-service\`.`,
  });
  if (r.status === 0) return;
  if (isAccessDenied(r)) throw new AdminRequiredError("install-service");
  throw new Error(`Couldn't create the task: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
}

/** The task's state as Task Scheduler says it (Ready, Disabled...); null when there is none. */
export function taskState(run: Exec = exec): string | null {
  const r = run("schtasks.exe", ["/Query", "/TN", TASK_NAME, "/FO", "CSV", "/NH"]);
  if (r.status !== 0) return isAccessDenied(r) ? "unknown (no access)" : null;
  // "\\aimc-host","N/A","Ready"
  const fields = r.stdout.trim().split("\n")[0]?.split('","') ?? [];
  return fields.at(-1)?.replace(/"\s*$/, "").trim() || "unknown";
}

export function deleteTask(run: Exec = exec): void {
  const r = run("schtasks.exe", ["/Delete", "/TN", TASK_NAME, "/F"]);
  if (r.status === 0) return;
  if (isAccessDenied(r)) throw new AdminRequiredError("uninstall-service");
  throw new Error(`Task Scheduler: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
}

/** node.exe and cli.js for the task: the global install, which `npm install -g` updates in place. */
export function taskInputs(workDir: string): TaskInputs {
  const cliPath = realpathSync(process.argv[1] ?? "");
  if (process.env.npm_command === "exec" || /[\\/]_npx[\\/]/.test(cliPath)) {
    throw new Error(`Install the agent first (the service can't run from npx's cache): npm install -g ${PACKAGE_NAME}, then: ${PACKAGE_NAME} install-service`);
  }
  return { nodePath: realpathSync(process.execPath), cliPath, workDir };
}
