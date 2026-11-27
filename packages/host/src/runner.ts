import { parseStreamEvent, PROTOCOL_VERSION, type AgentJobEvent, type JobEvent } from "aimc-protocol/agent";
import { readSseData } from "aimc-protocol/sse";
import { NotSignedInError } from "./auth.ts";
import type { HostTokenSource } from "./host-token.ts";
import type { RunState } from "./instance.ts";
import { OllamaError, type OllamaClient } from "./ollama.ts";
import { ServerError, type ServerClient } from "./server-client.ts";
import type { GpuTelemetry } from "./telemetry.ts";
import { versionAdvice } from "./version.ts";

// `start`: what the agent does all day.
//
//   hello -> open the job stream -> run jobs as they come -> the stream closes (every ~5 min,
//   when the access token expires) -> hello again -> open the stream again ...
//
// Each job runs on the local Ollama. Its events go back to the server in small batches
// (every ~200 ms), numbered, so a retried batch is never counted twice. The server can cancel a
// job on the stream or in its answer to a batch. A heartbeat with telemetry goes out every 15 s.
//
// Never logged: prompts, answers, images, tokens. Logged: job ids, models, token counts, times.

/** Errors after which retrying makes no sense: the agent stops and says why. */
const FATAL = new Set([
  "host_not_found",
  "host_rejected",
  "host_retired",
  "account_not_found",
  "account_not_approved",
  "unsupported_protocol",
  "insufficient_scope",
  "agent_outdated",
]);

/** The agent should stop and not be restarted: the host was retired, the account suspended... */
export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }
}

export interface RunnerOptions {
  server: ServerClient;
  ollama: OllamaClient;
  hostId: string;
  models: string[];
  maxConcurrent: number;
  agentVersion: string;
  readGpu: () => Promise<GpuTelemetry | null>;
  log: (message: string) => void;
  signal: AbortSignal;
  batchMs?: number;
  /** Waiting before asking again while the host is pending or paused. */
  idleRetryMs?: number;
  maxBackoffMs?: number;
  /** Hashed machine id, sent with hello. */
  machineId?: string;
  /** What the agent is doing now (for `status`). */
  onState?: (state: RunState, detail?: string) => void;
  /** A job finished (any outcome). */
  onJobDone?: () => void;
  /** Another copy holds the host: how long to keep checking (it may have just stopped) before giving up. */
  conflictGraceMs?: number;
  conflictRetryMs?: number;
  /** Host token mode: the token (the server may refuse it; the owner can make a new one). */
  hostToken?: HostTokenSource;
  /** After the server refused the host token: how long until trying it again... */
  tokenRetryMs?: number;
  /** ...and how often to look for a new token in the token file meanwhile. */
  tokenCheckMs?: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

export class Runner {
  private readonly o: RunnerOptions;
  private readonly jobs = new Map<string, { abort: AbortController; reason: "cancelled" | "deadline" | null }>();
  private limit: number;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastNotice = "";
  private lastUpdateNotice = "";
  private conflictSince: number | null = null;

  constructor(options: RunnerOptions) {
    this.o = options;
    this.limit = options.maxConcurrent;
  }

  private notice(message: string) {
    // Don't repeat "waiting for approval" every minute.
    if (message !== this.lastNotice) this.o.log(message);
    this.lastNotice = message;
  }

  /** Runs until `signal` aborts (Ctrl+C) or a fatal error (thrown, with a message for the owner). */
  async run(): Promise<void> {
    const { signal } = this.o;
    let backoff = 1000;
    const state = (s: RunState, detail?: string) => this.o.onState?.(s, detail);
    try {
      while (!signal.aborted) {
        try {
          const hello = await this.hello();
          this.conflictSince = null;
          const advice = versionAdvice(this.o.agentVersion, hello);
          if (advice?.kind === "too_old") throw new FatalError(advice.message);
          if (advice && advice.message !== this.lastUpdateNotice) {
            // Once per new version: hello repeats every few minutes.
            this.o.log(advice.message);
            this.lastUpdateNotice = advice.message;
          }
          this.limit = hello.maxConcurrent;
          this.startHeartbeat(hello.heartbeatIntervalMs);
          if (hello.status === "pending_approval") {
            state("waiting_for_approval");
            this.notice("Registered and waiting for an admin to approve this host. Checking again every minute.");
            await sleep(this.o.idleRetryMs ?? 60_000, signal);
            continue;
          }
          if (hello.status === "paused") {
            state("paused");
            this.notice("This host is paused. Resume it to get jobs again. Checking every minute.");
            await sleep(this.o.idleRetryMs ?? 60_000, signal);
            continue;
          }
          await this.stream();
          backoff = 1000;
          await sleep(500, signal); // the server closed the stream (token expiry, deploy): reconnect
        } catch (err) {
          if (signal.aborted) break;
          if (err instanceof NotSignedInError || err instanceof FatalError) throw err;
          if (err instanceof ServerError) {
            if (err.status === 401 && this.o.hostToken) {
              await this.tokenRefused(err);
              continue;
            }
            if (FATAL.has(err.code)) throw new FatalError(err.message);
            if (err.code === "host_already_connected") {
              // Two copies of one host. Maybe the other one was stopped a moment ago and the
              // server hasn't noticed yet: keep checking for a minute, then give up.
              const now = Date.now();
              this.conflictSince ??= now;
              const grace = this.o.conflictGraceMs ?? 60_000;
              if (now - this.conflictSince >= grace) throw new FatalError(err.message);
              state("blocked");
              this.notice(`${err.message} Checking again for up to ${Math.round(grace / 1000)} s in case it was just stopped.`);
              await sleep(this.o.conflictRetryMs ?? 15_000, signal);
              continue;
            }
            if (err.code === "host_pending" || err.code === "host_paused") {
              state(err.code === "host_pending" ? "waiting_for_approval" : "paused");
              this.notice(err.message);
              await sleep(this.o.idleRetryMs ?? 60_000, signal);
              continue;
            }
            if (err.code === "hello_required") continue;
          }
          state("reconnecting", (err as Error).message);
          this.o.log(`Connection problem: ${(err as Error).message}. Retrying in ${Math.round(backoff / 1000)} s.`);
          await sleep(backoff, signal);
          backoff = Math.min(backoff * 2, this.o.maxBackoffMs ?? 60_000);
        }
      }
    } finally {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      for (const job of this.jobs.values()) {
        job.reason = "cancelled";
        job.abort.abort();
      }
    }
  }

  /**
   * The server refused the host token: it was replaced by a new one, deleted with its host, or
   * mistyped. Says so once, then waits (reading the token file again every half minute, when
   * there is one) and tries again: the owner may be about to fix it.
   */
  private async tokenRefused(err: ServerError) {
    const token = this.o.hostToken!;
    const retryMs = this.o.tokenRetryMs ?? 300_000;
    const checkMs = Math.min(this.o.tokenCheckMs ?? 30_000, retryMs);
    this.o.onState?.("token_refused", err.code);
    const fix = token.canReload
      ? "put it into the token file (the agent reads the file again every half minute)"
      : "set AIMC_HOST_TOKEN to it and restart the agent";
    this.notice(
      `The server refused the host token ${token.hint()} (${err.code}: ${err.message}) Make a new token for this host on the website (Hosts, New token) and ${fix}. Trying again every ${Math.round(retryMs / 60_000)} min.`,
    );
    for (let waited = 0; waited < retryMs && !this.o.signal.aborted; waited += checkMs) {
      await sleep(checkMs, this.o.signal);
      if (token.reload()) {
        this.o.log(`Read a new host token ${token.hint()} from the token file; trying it.`);
        this.lastNotice = "";
        return;
      }
    }
  }

  private async hello() {
    const [gpu, ollamaVersion] = await Promise.all([this.o.readGpu(), this.o.ollama.version().catch(() => undefined)]);
    return this.o.server.hello(this.o.hostId, {
      protocolVersion: PROTOCOL_VERSION,
      agentVersion: this.o.agentVersion,
      offeredModels: this.o.models,
      maxConcurrent: this.o.maxConcurrent,
      hardware: gpu ? { gpuName: gpu.name, vramMb: gpu.vramTotalMb } : {},
      ...(ollamaVersion ? { ollamaVersion } : {}),
      ...(this.o.machineId ? { machineId: this.o.machineId } : {}),
    });
  }

  private startHeartbeat(intervalMs: number) {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      void this.sendHeartbeat();
    }, intervalMs);
  }

  private async sendHeartbeat() {
    try {
      const [gpu, loaded, ollamaVersion] = await Promise.all([
        this.o.readGpu(),
        this.o.ollama.loaded().catch(() => []),
        this.o.ollama.version().catch(() => undefined),
      ]);
      await this.o.server.heartbeat(this.o.hostId, {
        ...(gpu ? { gpu } : {}),
        loadedModels: loaded,
        ...(ollamaVersion ? { ollamaVersion } : {}),
      });
    } catch {
      // A missed heartbeat is fine; the stream loop notices real connection problems.
    }
  }

  private async stream() {
    const control = new AbortController();
    const stop = () => control.abort();
    this.o.signal.addEventListener("abort", stop, { once: true });
    try {
      const body = await this.o.server.openStream(this.o.hostId, control.signal);
      this.lastNotice = "";
      this.o.onState?.("connected");
      this.o.log(`Connected. Offering ${this.o.models.join(", ")}; up to ${this.limit} job(s) at once.`);
      for await (const data of readSseData(body)) {
        const event = parseStreamEvent(data);
        if (!event) continue; // unknown or broken: ignore
        if (event.type === "job") this.startJob(event);
        else if (event.type === "cancel") this.cancel(event.jobId, "cancelled");
        else if (event.type === "config") this.limit = Math.min(event.maxConcurrent, this.o.maxConcurrent);
      }
    } catch (err) {
      if (!control.signal.aborted) throw err;
    } finally {
      this.o.signal.removeEventListener("abort", stop);
    }
  }

  private cancel(jobId: string, reason: "cancelled" | "deadline") {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.reason ??= reason;
    job.abort.abort();
  }

  private startJob(job: JobEvent) {
    const refuse = (code: "model_not_offered" | "busy", retryable: boolean) =>
      this.o.server.jobEvents(this.o.hostId, job.jobId, 0, [{ type: "error", code, retryable }]).catch(() => false);
    if (!this.o.models.includes(job.model)) {
      this.o.log(`Refused job ${job.jobId}: ${job.model} is not on your offered list.`);
      void refuse("model_not_offered", false);
      return;
    }
    if (this.jobs.size >= this.limit) {
      void refuse("busy", true);
      return;
    }
    const entry = { abort: new AbortController(), reason: null as "cancelled" | "deadline" | null };
    this.jobs.set(job.jobId, entry);
    void this.runJob(job, entry).finally(() => {
      this.jobs.delete(job.jobId);
      this.o.onJobDone?.();
    });
  }

  private async runJob(job: JobEvent, entry: { abort: AbortController; reason: "cancelled" | "deadline" | null }) {
    const started = Date.now();
    const deadline = setTimeout(() => this.cancel(job.jobId, "deadline"), job.deadlineMs);
    let seq = 0;
    let pending: AgentJobEvent[] = [];
    let chain: Promise<void> = Promise.resolve();
    let serverGone = false;

    // Sends what is pending, one batch at a time, in order. Merges consecutive deltas.
    const flush = () => {
      chain = chain.then(async () => {
        if (pending.length === 0 || serverGone) return;
        const batch: AgentJobEvent[] = [];
        for (const e of pending) {
          const last = batch.at(-1);
          if (e.type === "delta" && last?.type === "delta" && last.text.length + e.text.length <= 50_000) last.text += e.text;
          else batch.push(e.type === "delta" ? { ...e } : e);
        }
        pending = [];
        const mySeq = seq++;
        for (let attempt = 0; ; attempt++) {
          try {
            if (await this.o.server.jobEvents(this.o.hostId, job.jobId, mySeq, batch)) {
              entry.reason ??= "cancelled";
              entry.abort.abort();
            }
            return;
          } catch (err) {
            // The server refused the batch (job gone, host paused...): stop. Network: retry the SAME seq.
            if (err instanceof ServerError || attempt >= 3) {
              serverGone = true;
              entry.reason ??= "cancelled";
              entry.abort.abort();
              return;
            }
            await sleep(500 * (attempt + 1), this.o.signal);
          }
        }
      });
      return chain;
    };
    const ticker = setInterval(() => void flush(), this.o.batchMs ?? 200);

    let completionTokens: number | undefined;
    let outcome = "done";
    try {
      for await (const event of this.o.ollama.chat(job, entry.abort.signal)) {
        pending.push(event);
        if (event.type === "done") completionTokens = event.usage?.completionTokens;
      }
    } catch (err) {
      if (entry.abort.signal.aborted) {
        outcome = entry.reason ?? "cancelled";
        if (entry.reason === "deadline") pending.push({ type: "error", code: "deadline_exceeded", retryable: false });
        else pending = []; // cancelled: the server isn't waiting for anything more
      } else if (err instanceof OllamaError) {
        outcome = err.code;
        pending.push({ type: "error", code: err.code, retryable: err.code === "ollama_unreachable" });
      } else {
        outcome = "internal";
        pending.push({ type: "error", code: "internal", retryable: true });
      }
    } finally {
      clearInterval(ticker);
      clearTimeout(deadline);
      await flush();
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    this.o.log(`Job ${job.jobId} ${job.model}: ${outcome}${completionTokens !== undefined ? `, ${completionTokens} tokens` : ""}, ${seconds} s`);
  }

  /** Jobs running now (for tests). */
  running(): number {
    return this.jobs.size;
  }
}
