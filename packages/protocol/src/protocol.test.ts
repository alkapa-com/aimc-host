import {
  helloRequest,
  jobEventsRequest,
  parseStreamEvent,
  PROTOCOL_VERSION,
  registerHostRequest,
  type StreamEvent,
} from "./agent.ts";
import { encodeSseComment, encodeSseData, readSseData } from "./sse.ts";
import { describe, expect, it } from "vitest";

const JOB_ID = "6f2a1b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b";

const job: StreamEvent = {
  type: "job",
  jobId: JOB_ID,
  model: "qwen3-vl:8b-instruct",
  messages: [{ role: "user", content: "Read this receipt", images: ["iVBORw0KGgo="] }],
  options: { numPredict: 800, temperature: 0, format: { type: "object", properties: { total: { type: "number" } } }, think: false },
  deadlineMs: 300_000,
};

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const data of readSseData(body)) out.push(data);
  return out;
}

describe("agent protocol", () => {
  it("is version 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("carries JSON output and the think switch in a job", () => {
    expect(parseStreamEvent(job)).toEqual(job);
    expect(parseStreamEvent({ ...job, options: { numPredict: 10, format: "json" } })).toMatchObject({ options: { format: "json" } });
    expect(parseStreamEvent({ ...job, options: { numPredict: 10, format: "xml" } })).toBeNull();
  });

  it("ignores unknown and broken stream events instead of failing", () => {
    expect(parseStreamEvent({ type: "reboot" })).toBeNull();
    expect(parseStreamEvent({ type: "job", jobId: "not-a-uuid" })).toBeNull();
    expect(parseStreamEvent("ping")).toBeNull();
    expect(parseStreamEvent({ type: "ping", extra: 1 })).toEqual({ type: "ping" });
  });

  it("refuses model names and options an agent must never act on", () => {
    expect(parseStreamEvent({ ...job, model: "../../etc/passwd" })).toBeNull();
    expect(parseStreamEvent({ ...job, model: "model; rm -rf /" })).toBeNull();
    expect(parseStreamEvent({ ...job, options: { numPredict: 0 } })).toBeNull();
  });

  it("validates hello, defaulting the owner's limit to 1", () => {
    const hello = helloRequest.parse({ protocolVersion: 1, agentVersion: "0.1.0", offeredModels: ["gemma3:12b"] });
    expect(hello).toMatchObject({ maxConcurrent: 1, hardware: {} });
    expect(helloRequest.safeParse({ protocolVersion: 1, agentVersion: "0.1.0", offeredModels: ["bad name"] }).success).toBe(false);
  });

  it("validates job event batches: at least one event, known types only", () => {
    expect(jobEventsRequest.safeParse({ seq: 0, events: [{ type: "delta", text: "Hi" }, { type: "done", finishReason: "stop" }] }).success).toBe(true);
    expect(jobEventsRequest.safeParse({ seq: 0, events: [] }).success).toBe(false);
    expect(jobEventsRequest.safeParse({ seq: 0, events: [{ type: "error", code: "rm -rf", retryable: true }] }).success).toBe(false);
    expect(jobEventsRequest.safeParse({ seq: -1, events: [{ type: "delta", text: "x" }] }).success).toBe(false);
  });

  it("trims host names and refuses odd ones", () => {
    expect(registerHostRequest.parse({ name: "  alex-desktop " })).toEqual({ name: "alex-desktop" });
    expect(registerHostRequest.safeParse({ name: "<script>" }).success).toBe(false);
    expect(registerHostRequest.safeParse({ name: "" }).success).toBe(false);
    const machineId = "a".repeat(64);
    expect(registerHostRequest.parse({ name: "pc", machineId, force: true })).toEqual({ name: "pc", machineId, force: true });
    // Only a hash: never a raw machine id.
    expect(registerHostRequest.safeParse({ name: "pc", machineId: "4c4c4544-0042-3510-8051-b4c04f4e3132" }).success).toBe(false);
    expect(helloRequest.parse({ protocolVersion: 1, agentVersion: "0.3.0", offeredModels: [], machineId }).machineId).toBe(machineId);
  });

  it("reads SSE data cut at any byte, skipping comments and non-JSON", async () => {
    const bytes = new Uint8Array([
      ...encodeSseComment("hello"),
      ...encodeSseData(job),
      ...new TextEncoder().encode("data: not json\n\n"),
      ...encodeSseData({ type: "ping" }),
    ]);
    const oneByOne = [...bytes].map((b) => new Uint8Array([b]));
    expect(await collect(streamOf(...oneByOne))).toEqual([job, { type: "ping" }]);
    expect(await collect(streamOf(new TextEncoder().encode('data: {"type":"ping"}\r\n\r\n')))).toEqual([{ type: "ping" }]);
  });
});
