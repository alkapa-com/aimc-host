import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlreadyRunningError, describeState, isAlive, liveRun, readRun, RunFile, stopRun, type RunInfo } from "./instance.ts";
import { hashMachineId, machineId } from "./machine.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aimc-run-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const start = (over: Partial<RunInfo> = {}) => ({ pid: process.pid, runId: crypto.randomUUID(), mode: "terminal" as const, hostId: "h1", version: "0.3.0", ...over });

/** A pid that surely isn't running any more. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  return child.pid!;
}

describe("one agent per settings folder", () => {
  it("refuses a second start while the first runs", async () => {
    const first = await RunFile.acquire(dir, start());
    const err = await RunFile.acquire(dir, start()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlreadyRunningError);
    expect((err as AlreadyRunningError).info.runId).toBe(first.current.runId);
    await first.release();
    expect(await readRun(dir)).toBeNull();
    const second = await RunFile.acquire(dir, start());
    await second.release();
  });

  it("takes over a run file left by an agent that crashed", async () => {
    const now = new Date().toISOString();
    await writeFile(join(dir, "run.json"), JSON.stringify({ ...start({ pid: deadPid() }), startedAt: now, updatedAt: now, state: "connected", jobsDone: 3 }));
    expect(await liveRun(dir)).toBeNull();
    const run = await RunFile.acquire(dir, start());
    expect((await readRun(dir))?.runId).toBe(run.current.runId);
    await run.release();
  });

  it("writes what it is doing, for status", async () => {
    const run = await RunFile.acquire(dir, start());
    run.update("reconnecting", "Can't reach the server");
    run.update("connected");
    run.jobDone();
    await new Promise((r) => setTimeout(r, 50));
    const info = (await readRun(dir))!;
    expect(info).toMatchObject({ state: "connected", jobsDone: 1, mode: "terminal", hostId: "h1" });
    expect(info.detail).toBeUndefined();
    expect(isAlive(info)).toBe(true);
    expect(describeState(info)).toMatch(/^connected, taking jobs; 1 job\(s\) done/);
    await run.release();
  });

  it("doesn't delete another agent's run file when releasing", async () => {
    const run = await RunFile.acquire(dir, start());
    const now = new Date().toISOString();
    await writeFile(join(dir, "run.json"), JSON.stringify({ ...start({ runId: "someone-else" }), startedAt: now, updatedAt: now, state: "connected", jobsDone: 0 }));
    await run.release();
    expect((await readRun(dir))?.runId).toBe("someone-else");
  });

  it("stop asks the running agent to stop and waits until it has", async () => {
    expect(await stopRun(dir, 1000, () => {})).toBe(false); // nothing running
    // A stand-in agent in its own process: claims the folder and stops when asked.
    const script = join(dir, "agent.ts");
    await writeFile(
      script,
      `import { RunFile } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "instance.ts")).href)};
const run = await RunFile.acquire(process.argv[2], { pid: process.pid, runId: crypto.randomUUID(), mode: "terminal", hostId: "h1", version: "0.3.0" });
const keepAlive = setInterval(() => {}, 1000);
const stop = async () => { clearInterval(keepAlive); await run.release(); };
run.watchStop(stop);
process.once("SIGTERM", stop); // like the agent: Linux stops it with SIGTERM at once
`,
    );
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script, dir], { stdio: "ignore" });
    const deadline = Date.now() + 10_000;
    while (!(await liveRun(dir))) {
      if (Date.now() > deadline) throw new Error("the stand-in agent didn't start");
      await new Promise((r) => setTimeout(r, 50));
    }
    const lines: string[] = [];
    expect(await stopRun(dir, 10_000, (m) => lines.push(m))).toBe(true);
    expect(lines.at(-1)).toBe("Stopped.");
    expect(existsSync(join(dir, "run.json"))).toBe(false);
    expect(child.exitCode ?? (await new Promise((r) => child.once("exit", r)))).toBe(0);
  }, 30_000);
});

describe("machine id", () => {
  it("only a hash leaves the machine, the same for the same id", () => {
    const a = hashMachineId("4C4C4544-0042-3510-8051-B4C04F4E3132");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMachineId(" 4c4c4544-0042-3510-8051-b4c04f4e3132\n")).toBe(a);
    expect(a).not.toContain("4c4c4544");
    expect(hashMachineId("another")).not.toBe(a);
  });

  it("finds this machine's id (or none, never a broken one)", () => {
    const id = machineId();
    if (id !== undefined) expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(machineId()).toBe(id);
  });
});
