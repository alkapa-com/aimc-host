import type { AgentJobEvent, JobEvent } from "aimc-protocol/agent";
import type { FetchFn } from "./auth.ts";

// The bridge to your local Ollama. It calls exactly four endpoints, all read-only or chat:
// /api/chat, /api/tags, /api/ps and /api/version. Never pull, delete, create, copy or push:
// the server can't make this agent change what's installed on your machine.

export type OllamaErrorCode = "ollama_unreachable" | "ollama_error" | "thinking_not_supported" | "images_not_supported";

export class OllamaError extends Error {
  readonly code: OllamaErrorCode;

  constructor(code: OllamaErrorCode, message: string) {
    super(message);
    this.name = "OllamaError";
    this.code = code;
  }
}

/** Ollama reports durations in nanoseconds; the protocol uses milliseconds. */
function nsToMs(ns: unknown): number | undefined {
  return typeof ns === "number" && Number.isFinite(ns) && ns >= 0 ? Math.round(ns / 1e6) : undefined;
}

interface ChatLine {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
  error?: string;
}

export class OllamaClient {
  private readonly fetchFn: FetchFn;
  private readonly baseUrl: string;

  constructor(fetchFn: FetchFn, baseUrl: string) {
    this.fetchFn = fetchFn;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async call(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, { ...init, signal: signal ?? AbortSignal.timeout(5000) });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new OllamaError("ollama_unreachable", `Ollama at ${this.baseUrl} is not reachable (${(err as Error).message}).`);
    }
    if (!res.ok) {
      let reason = "";
      try {
        reason = ((await res.json()) as { error?: string }).error ?? "";
      } catch {
        // no JSON body
      }
      // Ollama's refusals of the request itself: another host would refuse it too.
      const code: OllamaErrorCode =
        res.status === 400 && /does not support thinking/i.test(reason)
          ? "thinking_not_supported"
          : res.status === 400 && /does not support (multimodal|images?|vision)/i.test(reason)
            ? "images_not_supported"
            : "ollama_error";
      throw new OllamaError(code, `Ollama ${path} answered HTTP ${res.status}${reason ? `: ${reason.slice(0, 200)}` : ""}`);
    }
    return res;
  }

  async version(): Promise<string> {
    const body = (await (await this.call("/api/version")).json()) as { version?: string };
    return body.version ?? "unknown";
  }

  /** The models installed in Ollama. */
  async installed(): Promise<string[]> {
    const body = (await (await this.call("/api/tags")).json()) as { models?: { name: string }[] };
    return (body.models ?? []).map((m) => m.name);
  }

  /** The models loaded in GPU memory right now. */
  async loaded(): Promise<{ name: string; vramMb: number; expiresAt?: string }[]> {
    const body = (await (await this.call("/api/ps")).json()) as { models?: { name: string; size_vram?: number; expires_at?: string }[] };
    return (body.models ?? []).map((m) => ({
      name: m.name,
      vramMb: Math.round((m.size_vram ?? 0) / 1024 / 1024),
      ...(m.expires_at ? { expiresAt: m.expires_at.slice(0, 40) } : {}),
    }));
  }

  /**
   * Runs a job and yields its events: deltas, then one "done". Throws OllamaError on failure.
   * Aborting `signal` stops the generation (closing the HTTP response makes Ollama stop).
   */
  async *chat(job: JobEvent, signal: AbortSignal): AsyncGenerator<AgentJobEvent> {
    const o = job.options;
    const res = await this.call(
      "/api/chat",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: job.model,
          messages: job.messages.map((m) => (m.images?.length ? { role: m.role, content: m.content, images: m.images } : { role: m.role, content: m.content })),
          stream: true,
          ...(o.format !== undefined ? { format: o.format } : {}),
          ...(o.think !== undefined ? { think: o.think } : {}),
          options: {
            num_predict: o.numPredict,
            ...(o.numCtx !== undefined ? { num_ctx: o.numCtx } : {}),
            ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
            ...(o.topP !== undefined ? { top_p: o.topP } : {}),
            ...(o.stop?.length ? { stop: o.stop } : {}),
            ...(o.seed !== undefined ? { seed: o.seed } : {}),
          },
        }),
      },
      signal,
    );
    if (!res.body) throw new OllamaError("ollama_error", "Ollama sent an empty response.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        // At the end, a last line without a newline still counts.
        if (done) buffer += `${decoder.decode()}\n`;
        else buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let data: ChatLine;
          try {
            data = JSON.parse(line) as ChatLine;
          } catch {
            throw new OllamaError("ollama_error", "Ollama sent a line that is not JSON.");
          }
          if (data.error) throw new OllamaError("ollama_error", `Ollama error: ${data.error.slice(0, 200)}`);
          if (data.message?.content) yield { type: "delta", text: data.message.content };
          if (data.done) {
            const hasUsage = typeof data.prompt_eval_count === "number" || typeof data.eval_count === "number";
            yield {
              type: "done",
              finishReason: data.done_reason === "length" ? "length" : "stop",
              ...(hasUsage ? { usage: { promptTokens: data.prompt_eval_count ?? 0, completionTokens: data.eval_count ?? 0 } } : {}),
              timings: {
                ...(nsToMs(data.load_duration) !== undefined ? { loadMs: nsToMs(data.load_duration) } : {}),
                ...(nsToMs(data.prompt_eval_duration) !== undefined ? { promptEvalMs: nsToMs(data.prompt_eval_duration) } : {}),
                ...(nsToMs(data.eval_duration) !== undefined ? { evalMs: nsToMs(data.eval_duration) } : {}),
              },
            };
            return;
          }
        }
        if (done) break;
      }
      throw new OllamaError("ollama_error", "Ollama closed the stream before it was done.");
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}
