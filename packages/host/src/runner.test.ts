import type { JobEvent } from "aimc-protocol/agent";
import { encodeSseData } from "aimc-protocol/sse";
import { afterEach, describe, expect, it } from "vitest";
import type { TokenSource } from "./auth.ts";
import { controlledStream, fakeFetch, json } from "./fake-fetch.ts";
import { OllamaClient } from "./ollama.ts";
import { FatalError, Runner } from "./runner.ts";
import { ServerClient } from "./server-client.ts";

// `start` against a fake aimc server and a fake Ollama.

const HOST = "11111111-2222-4333-8444-555555555555";
const tokens = { get: async () => "access-token", invalidate() {} } as unknown as TokenSource;

type Stream = ReturnType<typeof controlledStream>;

function setup(opts: { hello?: (number | "pending_approval" | "active" | "paused" | { status: number; code: string })[]; models?: string[]; maxConcurrent?: number; helloExtra?: Record<string, unknown> } = {}) {
  const helloAnswers = opts.hello ?? ["active"];
  const state = {
    helloCalls: 0,
    streams: [] as Stream[],
    posts: [] as { jobId: string; seq: number; events: { type: string; text?: string; code?: string }[] }[],
    cancelAnswers: new Set<string>(),
    ollamaCalls: [] as unknown[],
    ollamaStreams: [] as Stream[],
    logs: [] as string[],
  };
  const server = fakeFetch((_method, path) => {
    if (path.endsWith("/hello")) {
      return () => {
        const answer = helloAnswers[Math.min(state.helloCalls++, helloAnswers.length - 1)]!;
        if (typeof answer === "object") return json({ error: { code: answer.code, message: `refused: ${answer.code}` } }, answer.status);
        return json({ status: answer, maxConcurrent: opts.maxConcurrent ?? 1, heartbeatIntervalMs: 60_000, ...opts.helloExtra });
      };
    }
    if (path.endsWith("/stream")) {
      return (_url, init) => {
        const stream = controlledStream(init.signal);
        state.streams.push(stream);
        return new Response(stream.body, { headers: { "content-type": "text/event-stream" } });
      };
    }
    if (path.includes("/jobs/")) {
      return (_url, init) => {
        const jobId = path.split("/")[7]!;
        state.posts.push({ jobId, ...(JSON.parse(init.body as string) as { seq: number; events: [] }) });
        return json({ cancelled: state.cancelAnswers.has(jobId) });
      };
    }
    if (path.endsWith("/heartbeat")) return () => json({ ok: true });
    return undefined;
  });
  const ollama = fakeFetch((_method, path) => {
    if (path === "/api/chat") {
      return (_url, init) => {
        state.ollamaCalls.push(JSON.parse(init.body as string));
        const stream = controlledStream(init.signal);
        state.ollamaStreams.push(stream);
        return new Response(stream.body);
      };
    }
    if (path === "/api/version") return () => json({ version: "0.40.16" });
    if (path === "/api/ps") return () => json({ models: [] });
    return undefined;
  });
  const stop = new AbortController();
  const runner = new Runner({
    server: new ServerClient(server.fetch, "https://aimc.test", tokens),
    ollama: new OllamaClient(ollama.fetch, "http://127.0.0.1:11434"),
    hostId: HOST,
    models: opts.models ?? ["gemma3:12b"],
    maxConcurrent: opts.maxConcurrent ?? 1,
    agentVersion: "0.1.0-test",
    readGpu: async () => ({ name: "RTX 4070", vramTotalMb: 12282, vramUsedMb: 100, utilizationPct: 0, temperatureC: 35 }),
    log: (m) => state.logs.push(m),
    signal: stop.signal,
    batchMs: 10,
    idleRetryMs: 10,
    maxBackoffMs: 20,
  });
  const running = runner.run();
  stops.push(() => stop.abort());
  return { state, runner, stop, running, server };
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const job = (over: Partial<JobEvent> = {}): JobEvent => ({
  type: "job",
  jobId: crypto.randomUUID(),
  model: "gemma3:12b",
  messages: [{ role: "user", content: "SECRET PROMPT" }],
  options: { numPredict: 50, think: false },
  deadlineMs: 60_000,
  ...over,
});

const send = (stream: Stream, event: unknown) => stream.write(new TextDecoder().decode(encodeSseData(event)));

describe("Runner (start)", () => {
  it("says hello, takes a job, runs it on Ollama and posts the answer in numbered batches", async () => {
    const { state, server } = setup();
    await until(() => state.streams.length === 1);
    const hello = server.calls.find((c) => c.url.endsWith("/hello"))!;
    expect(hello.body).toEqual({
      protocolVersion: 1,
      agentVersion: "0.1.0-test",
      offeredModels: ["gemma3:12b"],
      maxConcurrent: 1,
      hardware: { gpuName: "RTX 4070", vramMb: 12282 },
      ollamaVersion: "0.40.16",
    });
    expect(hello.headers.authorization).toBe("Bearer access-token");

    const j = job();
    send(state.streams[0]!, j);
    await until(() => state.ollamaStreams.length === 1);
    expect(state.ollamaCalls[0]).toMatchObject({ model: "gemma3:12b", think: false, options: { num_predict: 50 } });
    const ollama = state.ollamaStreams[0]!;
    ollama.write('{"message":{"content":"Hel"}}\n{"message":{"content":"lo"}}\n');
    await until(() => state.posts.length >= 1);
    ollama.write('{"message":{"content":" there"}}\n{"done":true,"done_reason":"stop","prompt_eval_count":5,"eval_count":3,"eval_duration":30000000}\n');
    ollama.close();
    await until(() => state.posts.some((p) => p.events.some((e) => e.type === "done")));

    const mine = state.posts.filter((p) => p.jobId === j.jobId);
    expect(mine.map((p) => p.seq)).toEqual(mine.map((_, i) => i));
    const text = mine.flatMap((p) => p.events).flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("");
    expect(text).toBe("Hello there");
    expect(mine[0]!.events).toEqual([{ type: "delta", text: "Hello" }]); // consecutive deltas merged
    expect(state.logs.join("\n")).not.toContain("SECRET");
    expect(state.logs.join("\n")).not.toContain("Hello");
  });

  it("stops Ollama when the server cancels, on the stream or in its answer", async () => {
    const { state } = setup({ maxConcurrent: 2 });
    await until(() => state.streams.length === 1);

    const a = job();
    send(state.streams[0]!, a);
    await until(() => state.ollamaStreams.length === 1);
    send(state.streams[0]!, { type: "cancel", jobId: a.jobId });
    await until(() => state.ollamaStreams[0]!.aborted);

    const b = job();
    state.cancelAnswers.add(b.jobId);
    send(state.streams[0]!, b);
    await until(() => state.ollamaStreams.length === 2);
    state.ollamaStreams[1]!.write('{"message":{"content":"x"}}\n');
    await until(() => state.ollamaStreams[1]!.aborted);
  });

  it("refuses models that aren't offered, and jobs beyond its limit", async () => {
    const { state } = setup();
    await until(() => state.streams.length === 1);
    const stranger = job({ model: "llama3.1:70b" });
    send(state.streams[0]!, stranger);
    await until(() => state.posts.length === 1);
    expect(state.posts[0]).toEqual({ jobId: stranger.jobId, seq: 0, events: [{ type: "error", code: "model_not_offered", retryable: false }] });
    expect(state.ollamaCalls).toHaveLength(0);

    send(state.streams[0]!, job());
    await until(() => state.ollamaStreams.length === 1);
    const second = job();
    send(state.streams[0]!, second);
    await until(() => state.posts.some((p) => p.jobId === second.jobId));
    expect(state.posts.find((p) => p.jobId === second.jobId)!.events).toEqual([{ type: "error", code: "busy", retryable: true }]);
  });

  it("reports a job that runs past its deadline", async () => {
    const { state } = setup();
    await until(() => state.streams.length === 1);
    const slow = job({ deadlineMs: 30 });
    send(state.streams[0]!, slow);
    await until(() => state.posts.some((p) => p.events.some((e) => e.code === "deadline_exceeded")));
    expect(state.ollamaStreams[0]!.aborted).toBe(true);
  });

  it("waits while pending approval, then connects; reconnects when the server closes the stream", async () => {
    const { state } = setup({ hello: ["pending_approval", "pending_approval", "active"] });
    await until(() => state.streams.length === 1);
    expect(state.helloCalls).toBe(3);
    expect(state.logs.filter((l) => l.includes("waiting for an admin"))).toHaveLength(1); // said once, not every minute

    state.streams[0]!.close(); // token expiry
    await until(() => state.streams.length === 2, 3000);
    expect(state.helloCalls).toBe(4);
  });

  it("stops with the server's message when the host was retired", async () => {
    const { running } = setup({ hello: [{ status: 403, code: "host_retired" }] });
    await expect(running).rejects.toThrow("refused: host_retired");
    await expect(running).rejects.toBeInstanceOf(FatalError); // exit code 3: systemd doesn't restart it
  });

  it("tells the owner once when the server recommends a newer agent", async () => {
    const { state } = setup({ hello: ["active"], helloExtra: { latestAgentVersion: "0.3.0" } });
    await until(() => state.streams.length === 1);
    state.streams[0]!.close();
    await until(() => state.streams.length === 2, 3000);
    expect(state.logs.filter((l) => l.includes("A newer host agent is available: 0.3.0"))).toHaveLength(1);
  });

  it("stops when the server needs a newer agent", async () => {
    const { running } = setup({ hello: ["active"], helloExtra: { minAgentVersion: "0.2.0", latestAgentVersion: "0.3.0" } });
    await expect(running).rejects.toThrow("needs host agent 0.2.0 or newer");
    await expect(running).rejects.toBeInstanceOf(FatalError);
  });

  it("stops when the server refuses an outdated agent", async () => {
    const { running } = setup({ hello: [{ status: 426, code: "agent_outdated" }] });
    await expect(running).rejects.toBeInstanceOf(FatalError);
  });

  it("retries after connection problems instead of giving up", async () => {
    const { state } = setup({ hello: [{ status: 502, code: "http_502" }, "active"] });
    await until(() => state.streams.length === 1);
    expect(state.logs.some((l) => l.startsWith("Connection problem"))).toBe(true);
  });

  it("stops cleanly on Ctrl+C, aborting running jobs", async () => {
    const { state, stop, running } = setup();
    await until(() => state.streams.length === 1);
    send(state.streams[0]!, job());
    await until(() => state.ollamaStreams.length === 1);
    stop.abort();
    await running;
    expect(state.ollamaStreams[0]!.aborted).toBe(true);
    expect(state.streams[0]!.aborted).toBe(true);
  });
});
