import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// One running agent per settings folder, and what it is doing right now.
//
// `start` creates run.json in the run folder (the settings folder, or /run/ai-my-card-host for
// the Linux service) and refuses to start while another live agent holds it. The running agent
// rewrites the file every 15 s with its state, so `status` can say whether it runs and how it
// is doing. `stop` asks it to stop by creating the file "stop" next to it.
//
// No secrets in here: pid, run id, host id, state, times.

export type RunState = "starting" | "connected" | "reconnecting" | "waiting_for_approval" | "paused" | "blocked" | "stopping";
export type RunMode = "terminal" | "service";

export interface RunInfo {
  pid: number;
  runId: string;
  mode: RunMode;
  hostId: string;
  version: string;
  startedAt: string;
  updatedAt: string;
  state: RunState;
  detail?: string;
  jobsDone: number;
  lastJobAt?: string;
  /** Where its output goes, when not to a terminal or the journal. */
  logFile?: string;
}

const RUN_FILE = "run.json";
const STOP_FILE = "stop";
const TOUCH_MS = 15_000;
/** A run file this old belongs to an agent that was asleep (laptop lid) or is gone. */
const FRESH_MS = 120_000;

export class AlreadyRunningError extends Error {
  readonly info: RunInfo;

  constructor(info: RunInfo) {
    super(`The agent is already running for this host (${describeRun(info)}). Stop it first: aimc-host stop`);
    this.name = "AlreadyRunningError";
    this.info = info;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to another user (the Linux service).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether `pid` is (still) an agent and not some process that reused the number. */
function looksLikeAgent(pid: number): boolean {
  try {
    let cmd: string;
    if (process.platform === "linux") cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    else if (process.platform === "win32") {
      cmd = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      });
    } else cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return /aimc-host|cli\.js|cli\.ts/.test(cmd);
  } catch {
    return true; // can't tell: assume it is, so we never run twice
  }
}

/** Is the agent of this run file still running? */
export function isAlive(info: RunInfo, now = Date.now()): boolean {
  if (!pidAlive(info.pid)) return false;
  if (now - Date.parse(info.updatedAt) < FRESH_MS) return true;
  // Not updated for a while: asleep, or the pid now belongs to something else.
  return looksLikeAgent(info.pid);
}

export async function readRun(dir: string): Promise<RunInfo | null> {
  try {
    return JSON.parse(await readFile(join(dir, RUN_FILE), "utf8")) as RunInfo;
  } catch {
    return null;
  }
}

/** The live run in `dir`, or null. */
export async function liveRun(dir: string): Promise<RunInfo | null> {
  const info = await readRun(dir);
  return info && isAlive(info) ? info : null;
}

function since(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} days`;
}

export function describeRun(info: RunInfo, now = Date.now()): string {
  return `${info.mode === "service" ? "as the service" : "in a terminal"}, pid ${info.pid}, for ${since(info.startedAt, now)}`;
}

const STATE_TEXT: Record<RunState, string> = {
  starting: "starting",
  connected: "connected, taking jobs",
  reconnecting: "reconnecting",
  waiting_for_approval: "waiting for an admin to approve this host",
  paused: "paused (resume it on the website)",
  blocked: "refused: another copy of this host is connected",
  stopping: "stopping",
};

export function describeState(info: RunInfo, now = Date.now()): string {
  const jobs = info.jobsDone === 0 ? "no jobs yet" : `${info.jobsDone} job(s) done, the last ${since(info.lastJobAt ?? info.updatedAt, now)} ago`;
  return `${STATE_TEXT[info.state] ?? info.state}${info.detail ? ` (${info.detail})` : ""}; ${jobs}`;
}

/** The running agent's handle on its run file. */
export class RunFile {
  readonly dir: string;
  private info: RunInfo;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopTimer: ReturnType<typeof setInterval> | null = null;
  private writing: Promise<void> = Promise.resolve();

  private constructor(dir: string, info: RunInfo) {
    this.dir = dir;
    this.info = info;
  }

  /** Claims the run folder, or throws AlreadyRunningError. */
  static async acquire(dir: string, start: Omit<RunInfo, "startedAt" | "updatedAt" | "state" | "jobsDone">): Promise<RunFile> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    const info: RunInfo = { ...start, startedAt: now, updatedAt: now, state: "starting", jobsDone: 0 };
    const path = join(dir, RUN_FILE);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const handle = await open(path, "wx", 0o644);
        await handle.writeFile(`${JSON.stringify(info, null, 2)}\n`);
        await handle.close();
        await rm(join(dir, STOP_FILE), { force: true }); // an old stop request is not for us
        const run = new RunFile(dir, info);
        run.timer = setInterval(() => void run.write(), TOUCH_MS);
        run.timer.unref();
        return run;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const other = await readRun(dir);
        if (other && isAlive(other)) throw new AlreadyRunningError(other);
        // Left behind by an agent that crashed or was killed: take it over.
        await rm(path, { force: true });
      }
    }
    throw new Error(`Couldn't claim ${path}; another agent may be starting right now.`);
  }

  get current(): RunInfo {
    return this.info;
  }

  update(state: RunState, detail?: string): void {
    if (state === this.info.state && detail === this.info.detail) return;
    this.info = { ...this.info, state };
    if (detail) this.info.detail = detail;
    else delete this.info.detail;
    void this.write();
  }

  jobDone(): void {
    this.info = { ...this.info, jobsDone: this.info.jobsDone + 1, lastJobAt: new Date().toISOString() };
    void this.write();
  }

  /** Calls `onStop` when someone runs `aimc-host stop`. */
  watchStop(onStop: () => void): void {
    const file = join(this.dir, STOP_FILE);
    this.stopTimer = setInterval(() => {
      if (!existsSync(file)) return;
      void rm(file, { force: true });
      onStop();
    }, 1000);
    this.stopTimer.unref();
  }

  private write(): Promise<void> {
    this.writing = this.writing.then(async () => {
      this.info = { ...this.info, updatedAt: new Date().toISOString() };
      const path = join(this.dir, RUN_FILE);
      const tmp = `${path}.${this.info.pid}.tmp`;
      try {
        await writeFile(tmp, `${JSON.stringify(this.info, null, 2)}\n`, { mode: 0o644 });
        await rename(tmp, path);
      } catch {
        // A missed update is fine; the next one comes in 15 s.
      }
    });
    return this.writing;
  }

  /** Gives the folder up (the agent stops). Leaves another agent's file alone. */
  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.stopTimer) clearInterval(this.stopTimer);
    await this.writing;
    const now = await readRun(this.dir);
    if (now?.runId === this.info.runId) await rm(join(this.dir, RUN_FILE), { force: true });
  }
}

/**
 * Asks the agent running in `dir` to stop (it checks every second), and waits until it has.
 * Kills it after `timeoutMs` if it doesn't. Returns false when nothing was running.
 */
export async function stopRun(dir: string, timeoutMs = 25_000, log: (m: string) => void = console.log): Promise<boolean> {
  const info = await liveRun(dir);
  if (!info) return false;
  log(`Stopping the agent (${describeRun(info)})...`);
  await writeFile(join(dir, STOP_FILE), `${new Date().toISOString()}\n`);
  if (process.platform !== "win32") {
    try {
      process.kill(info.pid, "SIGTERM"); // the same, but at once
    } catch {
      // not ours to signal (another user): the stop file does it
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!pidAlive(info.pid)) {
      log("Stopped.");
      return true;
    }
  }
  try {
    process.kill(info.pid, "SIGKILL");
    log(`It didn't stop within ${Math.round(timeoutMs / 1000)} s: ended it.`);
  } catch (err) {
    throw new Error(`Couldn't stop pid ${info.pid}: ${(err as Error).message}`);
  }
  await rm(join(dir, RUN_FILE), { force: true });
  return true;
}
