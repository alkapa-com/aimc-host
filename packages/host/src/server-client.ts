import {
  AGENT_RUN_HEADER,
  agentApiError,
  helloResponse,
  jobEventsResponse,
  registerHostResponse,
  type AgentJobEvent,
  type HeartbeatRequest,
  type HelloRequest,
  type HelloResponse,
} from "aimc-protocol/agent";
import type { FetchFn, TokenSource } from "./auth.ts";

// Calls to the server's agent API. Every call carries a fresh access token; a 401 refreshes the
// token once and retries (it may have expired a moment ago). With a run id, every call says
// which run of the agent it is (one copy per host: the server refuses a second run).

/** The server answered with an error: a fixed code and a message written for you. */
export class ServerError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ServerError";
    this.status = status;
    this.code = code;
  }
}

export class ServerClient {
  private readonly fetchFn: FetchFn;
  private readonly serverUrl: string;
  private readonly tokens: TokenSource;
  private readonly runId: string | undefined;

  constructor(fetchFn: FetchFn, serverUrl: string, tokens: TokenSource, runId?: string) {
    this.fetchFn = fetchFn;
    this.serverUrl = serverUrl;
    this.tokens = tokens;
    this.runId = runId;
  }

  private async call(path: string, init: RequestInit, timeoutMs: number | null = 30_000): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.get();
      const res = await this.fetchFn(`${this.serverUrl}/api/agent/v1${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}`, ...(this.runId ? { [AGENT_RUN_HEADER]: this.runId } : {}) },
        ...(timeoutMs !== null && !init.signal ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
      if (res.status === 401 && attempt === 0) {
        this.tokens.invalidate();
        continue;
      }
      if (!res.ok) {
        let code = `http_${res.status}`;
        let message = `The server answered HTTP ${res.status}.`;
        try {
          const parsed = agentApiError.safeParse(await res.json());
          if (parsed.success) ({ code, message } = parsed.data.error);
        } catch {
          // no JSON body
        }
        throw new ServerError(res.status, code, message);
      }
      return res;
    }
  }

  private async post<T>(path: string, body: unknown, parse: (v: unknown) => T): Promise<T> {
    const res = await this.call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return parse(await res.json());
  }

  register(name: string, machineId?: string, force?: boolean) {
    return this.post("/hosts", { name, ...(machineId ? { machineId } : {}), ...(force ? { force: true } : {}) }, (v) => registerHostResponse.parse(v));
  }

  hello(hostId: string, body: HelloRequest): Promise<HelloResponse> {
    return this.post(`/hosts/${hostId}/hello`, body, (v) => helloResponse.parse(v));
  }

  heartbeat(hostId: string, body: HeartbeatRequest): Promise<void> {
    return this.post(`/hosts/${hostId}/heartbeat`, body, () => undefined);
  }

  /** Sends a batch of one job's events. Returns true when the server says the job is cancelled. */
  async jobEvents(hostId: string, jobId: string, seq: number, events: AgentJobEvent[]): Promise<boolean> {
    return this.post(`/hosts/${hostId}/jobs/${jobId}/events`, { seq, events }, (v) => jobEventsResponse.parse(v).cancelled);
  }

  /** Opens the job stream. Stays open until the server closes it or `signal` aborts. */
  async openStream(hostId: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const res = await this.call(`/hosts/${hostId}/stream`, { method: "GET", headers: { accept: "text/event-stream" }, signal }, null);
    if (!res.body) throw new ServerError(502, "empty_stream", "The server opened an empty stream.");
    return res.body;
  }
}
