import { describe, expect, it } from "vitest";
import { STOP_CODES, stamp, supervise } from "./supervisor.ts";
import {
  AdminRequiredError,
  deleteTask,
  isAccessDenied,
  REGISTER_SCRIPT,
  registerTask,
  taskArguments,
  taskState,
  type Exec,
  type ExecResult,
} from "./windows-service.ts";

// The Windows task without Windows: a fake exec that records calls and answers like
// PowerShell and schtasks.exe do.

function fakeExec(answer: ExecResult) {
  const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
  const run: Exec = (cmd, args, env) => {
    calls.push({ cmd, args, ...(env ? { env } : {}) });
    return answer;
  };
  return { run, calls };
}

const ok: ExecResult = { status: 0, stdout: "", stderr: "" };
const denied: ExecResult = { status: 1, stdout: "", stderr: "ERROR: Access is denied.\r\n" };
const psDenied: ExecResult = {
  status: 1,
  stdout: "",
  stderr: "Register-ScheduledTask : Access is denied.\r\n+ CategoryInfo : PermissionDenied: (PS_ScheduledTask:Root/Microsoft/...) [Register-ScheduledTask], CimException\r\n    + FullyQualifiedErrorId : HRESULT 0x80070005",
};
const inputs = { nodePath: "C:\\Program Files\\nodejs\\node.exe", cliPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\aimc-host\\dist\\cli.js", workDir: "C:\\Users\\me\\AppData\\Roaming\\ai-my-card-host" };

describe("the Windows task", () => {
  it("runs as the user when they log in (no admin rights needed), one copy, no time limit", () => {
    // Not S4U ("whether logged in or not"): it needs admin rights, doesn't work for Entra ID
    // accounts, and Ollama on Windows only runs while you are logged in anyway.
    expect(REGISTER_SCRIPT).toContain("-LogonType Interactive");
    expect(REGISTER_SCRIPT).not.toContain("S4U");
    expect(REGISTER_SCRIPT).not.toContain("-AtStartup");
    expect(REGISTER_SCRIPT).toContain("-RunLevel Limited"); // not as administrator
    expect(REGISTER_SCRIPT).toContain("-AtLogOn -User $user");
    expect(REGISTER_SCRIPT).toContain("-MultipleInstances IgnoreNew");
    expect(REGISTER_SCRIPT).toContain("-ExecutionTimeLimit ([TimeSpan]::Zero)");
    expect(REGISTER_SCRIPT).toContain("-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries");
    expect(taskArguments(inputs)).toBe(`"${inputs.cliPath}" start --service`);
  });

  it("passes the paths as environment variables, never inside the script", () => {
    const { run, calls } = fakeExec(ok);
    registerTask(inputs, run);
    expect(calls[0]!.cmd).toBe("powershell.exe");
    expect(calls[0]!.args.at(-1)).toBe(REGISTER_SCRIPT);
    expect(calls[0]!.env).toMatchObject({ AIMC_NODE: inputs.nodePath, AIMC_ARGS: taskArguments(inputs), AIMC_WORKDIR: inputs.workDir, AIMC_TASK: "aimc-host" });
  });

  it("tries, and says to use an administrator terminal when Windows refuses", () => {
    expect(() => registerTask(inputs, fakeExec(psDenied).run)).toThrow(AdminRequiredError);
    expect(() => registerTask(inputs, fakeExec(psDenied).run)).toThrow(/"Run as administrator".*aimc-host install-service/);
    expect(() => deleteTask(fakeExec(denied).run)).toThrow(/aimc-host uninstall-service$/);
    // Any other failure is reported as it is, not as a rights problem.
    const other = () => registerTask(inputs, fakeExec({ status: 1, stdout: "", stderr: "The task XML is malformed.\r\n" }).run);
    expect(other).toThrow("Couldn't create the task: The task XML is malformed.");
    expect(other).not.toThrow(AdminRequiredError);
  });

  it("recognises Windows' ways of saying access denied", () => {
    expect(isAccessDenied(denied)).toBe(true);
    expect(isAccessDenied(psDenied)).toBe(true);
    expect(isAccessDenied({ status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." })).toBe(false);
  });

  it("reads the task's state, or none", () => {
    expect(taskState(fakeExec({ status: 0, stdout: '"\\aimc-host","N/A","Running"\r\n', stderr: "" }).run)).toBe("Running");
    expect(taskState(fakeExec({ status: 0, stdout: '"\\aimc-host","27/11/2026 08:00:00","Ready"\r\n', stderr: "" }).run)).toBe("Ready");
    expect(taskState(fakeExec({ status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." }).run)).toBeNull();
    expect(taskState(fakeExec(denied).run)).toBe("unknown (no access)");
  });
});

describe("the supervisor", () => {
  const run = (codes: number[], durations: number[] = []) => {
    let clock = 0;
    const waits: number[] = [];
    const logs: string[] = [];
    let i = 0;
    const result = supervise({
      runAgent: async () => {
        clock += durations[i] ?? 1000;
        return codes[i++]!;
      },
      log: (m) => logs.push(m),
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    return { result, waits, logs };
  };

  it("starts the agent again after a crash, waiting longer each time", async () => {
    const { result, waits, logs } = run([1, 1, 1, 0]);
    expect(await result).toBe(0);
    expect(waits).toEqual([30_000, 60_000, 120_000]);
    expect(logs.at(-1)).toContain("the agent stopped (exit 0)");
  });

  it("waits only 30 s again after the agent ran fine for a while", async () => {
    const { result, waits } = run([1, 1, 1, 0], [1000, 1000, 60 * 60_000, 1000]);
    await result;
    expect(waits).toEqual([30_000, 60_000, 30_000]);
  });

  it("stops for good when retrying is pointless or another copy runs", async () => {
    for (const code of [3, 4]) {
      const { result, waits } = run([code]);
      expect(await result).toBe(code);
      expect(waits).toEqual([]);
    }
    expect([...STOP_CODES.keys()]).toEqual([0, 3, 4]);
  });

  it("runs once per settings folder", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { claimSupervisor, liveSupervisor, releaseSupervisor } = await import("./supervisor.ts");
    const dir = await mkdtemp(join(tmpdir(), "aimc-sup-"));
    try {
      expect(liveSupervisor(dir, () => true)).toBeNull();
      expect(claimSupervisor(dir, () => true)).toBe(true);
      expect(liveSupervisor(dir, () => true)).toBeNull(); // it's us
      releaseSupervisor(dir);
      // Another (live) supervisor's file: refused. A dead one's: taken over.
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "supervisor.json"), JSON.stringify({ pid: 999_999 }));
      expect(claimSupervisor(dir, () => true)).toBe(false);
      expect(claimSupervisor(dir, () => false)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dates its log lines", () => {
    expect(stamp(new Date(2026, 10, 26, 8, 5, 9, 123))).toBe("2026-11-26 08:05:09"); // local time
  });
});
