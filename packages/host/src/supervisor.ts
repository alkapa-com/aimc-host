import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

// The Windows task runs this: it starts the agent hidden, with its output in agent.log, and
// starts it again after a crash, waiting 30 s, then longer if it keeps crashing. It stops when
// the agent stops cleanly (`aimc-host stop`: exit 0), when retrying is pointless (exit 3: host
// retired, signed out...), or when another copy already runs (exit 4).

export const LOG_FILE = "agent.log";
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Exit codes that end the supervisor instead of a restart. */
export const STOP_CODES = new Map<number, string>([
  [0, "the agent stopped"],
  [3, "the agent stopped for good (see above); fix that, then: aimc-host start"],
  [4, "another copy of the agent is already running"],
]);

export interface SuperviseOptions {
  /** Runs the agent once; resolves with its exit code. */
  runAgent: () => Promise<number>;
  log: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  firstDelayMs?: number;
  maxDelayMs?: number;
  /** A run longer than this counts as healthy: the next crash waits the first delay again. */
  healthyMs?: number;
  now?: () => number;
}

export async function supervise(o: SuperviseOptions): Promise<number> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const first = o.firstDelayMs ?? 30_000;
  let delay = first;
  for (;;) {
    const started = now();
    const code = await o.runAgent();
    const stop = STOP_CODES.get(code);
    if (stop) {
      o.log(`Supervisor: ${stop} (exit ${code}).`);
      return code;
    }
    if (now() - started > (o.healthyMs ?? 10 * 60_000)) delay = first;
    o.log(`Supervisor: the agent exited with code ${code}; starting it again in ${Math.round(delay / 1000)} s.`);
    await sleep(delay);
    delay = Math.min(delay * 2, o.maxDelayMs ?? 10 * 60_000);
  }
}

/** Opens agent.log for appending, moving a big one to agent.log.1 first. */
export function openLog(dir: string): { fd: number; path: string; write: (message: string) => void } {
  const path = join(dir, LOG_FILE);
  try {
    if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // no log yet
  }
  const fd = openSync(path, "a");
  return { fd, path, write: (message: string) => writeSync(fd, `${stamp()} ${message}\n`) };
}

/** Local time, like the clock on the taskbar: 2026-11-26 08:03:20. */
export function stamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** Runs `node cli.js start --service` as the supervised agent, hidden, output to the log. */
export function spawnAgent(logFd: number, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1] ?? "", ...args], {
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      env: { ...process.env, AIMC_SUPERVISED: "1", AIMC_SERVICE: "1", AIMC_LOG_DATES: "1" },
    });
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

export function closeLog(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
}

// ---- one supervisor at a time, started hidden -------------------------------------------

const SUPERVISOR_FILE = "supervisor.json";

/**
 * Starts the supervisor in the background, without a window, and returns at once: what the
 * task's `start --service` does at log-in, and what `start` does when the service is installed.
 */
export function startDetachedSupervisor(): void {
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1] ?? "", "start", "--service"], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, AIMC_DETACHED: "1", AIMC_SERVICE: "1" },
  });
  child.unref();
}

/** The running supervisor's pid, if one runs for this settings folder. */
export function liveSupervisor(dir: string, alive: (pid: number) => boolean): number | null {
  try {
    const { pid } = JSON.parse(readFileSync(join(dir, SUPERVISOR_FILE), "utf8")) as { pid: number };
    return pid !== process.pid && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Claims the folder for this supervisor; false when another one runs. */
export function claimSupervisor(dir: string, alive: (pid: number) => boolean): boolean {
  if (liveSupervisor(dir, alive)) return false;
  writeFileSync(join(dir, SUPERVISOR_FILE), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  return true;
}

export function releaseSupervisor(dir: string): void {
  try {
    const { pid } = JSON.parse(readFileSync(join(dir, SUPERVISOR_FILE), "utf8")) as { pid: number };
    if (pid === process.pid) rmSync(join(dir, SUPERVISOR_FILE), { force: true });
  } catch {
    // gone already
  }
}

/** The last lines of agent.log, to show why the agent didn't start. */
export function logTail(dir: string, lines = 15): string {
  try {
    return readFileSync(join(dir, LOG_FILE), "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log yet)";
  }
}
