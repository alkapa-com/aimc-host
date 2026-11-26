import { z } from "zod";

// The agent protocol, version 1: every message between an aimc server and a host agent.
// Both sides validate everything they receive with these schemas. Unknown stream event types are
// ignored (a newer server may send events an older agent doesn't know), unknown fields stripped.
//
// Compatibility: version 1 only ever grows. New fields are optional, new events and error codes
// are added, nothing is renamed or removed. A breaking change would be version 2, in a new
// major release of this package.
//
//   GET  /api/agent/v1/config                          no auth: where to sign in
//   POST /api/agent/v1/hosts                           register a host (pending approval)
//   POST /api/agent/v1/hosts/{id}/hello                versions, offered models, hardware
//   GET  /api/agent/v1/hosts/{id}/stream               SSE, server -> agent: job, cancel, config, ping
//   POST /api/agent/v1/hosts/{id}/jobs/{jobId}/events  agent -> server: deltas, done or error
//   POST /api/agent/v1/hosts/{id}/heartbeat            telemetry every 15 s
//
// Every non-2xx answer is { error: { code, message } } (agentApiError below).

export const PROTOCOL_VERSION = 1;
/** The scope an agent asks for: "host" carries the host API audience; offline_access a long-lived refresh token. */
export const AGENT_SCOPE = "openid offline_access host";
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Ollama-style model names, e.g. "qwen3-vl:8b-instruct" or "library/model:tag". */
const modelName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/);
const shortText = (max: number) => z.string().max(max);
const count = z.number().int().min(0).max(10_000_000);
const ms = z.number().int().min(0).max(24 * 3600 * 1000);

// ---- config ------------------------------------------------------------------------------

export const agentConfigResponse = z.object({
  issuer: z.url(),
  clientId: z.string().min(1),
  scope: z.string().min(1),
  protocolVersion: z.number().int(),
});
export type AgentConfigResponse = z.infer<typeof agentConfigResponse>;

// ---- register ----------------------------------------------------------------------------

export const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;

export const registerHostRequest = z.object({ name: z.string().trim().regex(HOST_NAME) });
export type RegisterHostRequest = z.infer<typeof registerHostRequest>;

export const registerHostResponse = z.object({ hostId: z.uuid(), status: z.literal("pending_approval") });
export type RegisterHostResponse = z.infer<typeof registerHostResponse>;

// ---- hello -------------------------------------------------------------------------------

export const helloRequest = z.object({
  protocolVersion: z.number().int(),
  agentVersion: shortText(40),
  /** The local Ollama models the owner offers (only these are ever run). */
  offeredModels: z.array(modelName).max(50),
  /** The owner's own limit for jobs at once; the server uses the smaller of this and the admin's. */
  maxConcurrent: z.number().int().min(1).max(32).default(1),
  hardware: z
    .object({ gpuName: shortText(100).optional(), vramMb: z.number().int().min(0).max(1_000_000).optional() })
    .default({}),
  ollamaVersion: shortText(40).optional(),
});
export type HelloRequest = z.input<typeof helloRequest>;

export const helloResponse = z.object({
  status: z.enum(["pending_approval", "active", "paused"]),
  /** Jobs at once this host gets (the smaller of the owner's and the admin's limit). */
  maxConcurrent: z.number().int().min(1),
  heartbeatIntervalMs: z.number().int().min(1000),
  /** The newest host agent version the server recommends; an older agent tells its owner to update. */
  latestAgentVersion: shortText(40).optional(),
  /** The oldest host agent version the server accepts; older agents are refused (426 agent_outdated). */
  minAgentVersion: shortText(40).optional(),
});
export type HelloResponse = z.infer<typeof helloResponse>;

// ---- the job stream (server -> agent) ----------------------------------------------------

export const jobMessage = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
  /** Base64 image data without the data: prefix, already validated by the server. */
  images: z.array(z.string()).max(16).optional(),
});

export const jobOptions = z.object({
  /** Ollama's num_predict: the most tokens to generate (already capped by the server). */
  numPredict: z.number().int().min(1).max(1_000_000),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  stop: z.array(z.string().max(200)).max(4).optional(),
  seed: z.number().int().optional(),
  /** Ollama's format: "json" for any JSON object, or a JSON Schema the answer must match. */
  format: z.union([z.literal("json"), z.record(z.string(), z.unknown())]).optional(),
  /** Ollama's think switch; missing = the model's default. */
  think: z.boolean().optional(),
  /** Ollama's num_ctx: the context size the server wants for this model; missing = Ollama's default. */
  numCtx: z.number().int().min(512).max(1_048_576).optional(),
});
export type JobOptions = z.infer<typeof jobOptions>;

export const jobEvent = z.object({
  type: z.literal("job"),
  jobId: z.uuid(),
  /** The model's name in the agent's Ollama (one of its offered models). */
  model: modelName,
  messages: z.array(jobMessage).min(1),
  options: jobOptions,
  /** Stop and report an error if the job isn't finished after this many milliseconds. */
  deadlineMs: ms,
});
export type JobEvent = z.infer<typeof jobEvent>;

export const cancelEvent = z.object({ type: z.literal("cancel"), jobId: z.uuid() });
export const configEvent = z.object({ type: z.literal("config"), maxConcurrent: z.number().int().min(1) });
export const pingEvent = z.object({ type: z.literal("ping") });

export const streamEvent = z.discriminatedUnion("type", [jobEvent, cancelEvent, configEvent, pingEvent]);
export type StreamEvent = z.infer<typeof streamEvent>;

/** Parses one event from the stream; null for unknown or broken events (ignored, never fatal). */
export function parseStreamEvent(data: unknown): StreamEvent | null {
  const result = streamEvent.safeParse(data);
  return result.success ? result.data : null;
}

// ---- job events (agent -> server) --------------------------------------------------------

export const deltaJobEvent = z.object({ type: z.literal("delta"), text: z.string().max(100_000) });
export const doneJobEvent = z.object({
  type: z.literal("done"),
  finishReason: z.enum(["stop", "length"]),
  usage: z.object({ promptTokens: count, completionTokens: count }).optional(),
  timings: z.object({ loadMs: ms.optional(), promptEvalMs: ms.optional(), evalMs: ms.optional() }).optional(),
});
/**
 * Codes an agent reports. "thinking_not_supported" / "images_not_supported": Ollama refused think
 * or images for this model (another host would refuse too). retryable = the server may try
 * another host if nothing was sent yet. New codes are only ever added, never renamed.
 */
export const AGENT_ERROR_CODES = [
  "model_not_offered",
  "ollama_unreachable",
  "ollama_error",
  "thinking_not_supported",
  "images_not_supported",
  "deadline_exceeded",
  "busy",
  "internal",
] as const;
export const errorJobEvent = z.object({
  type: z.literal("error"),
  code: z.enum(AGENT_ERROR_CODES),
  retryable: z.boolean(),
});

export const agentJobEvent = z.discriminatedUnion("type", [deltaJobEvent, doneJobEvent, errorJobEvent]);
export type AgentJobEvent = z.infer<typeof agentJobEvent>;

export const jobEventsRequest = z.object({
  /** 0, 1, 2… per job: lets the server drop a batch it already got (the agent retried). */
  seq: z.number().int().min(0).max(1_000_000),
  events: z.array(agentJobEvent).min(1).max(500),
});
export type JobEventsRequest = z.infer<typeof jobEventsRequest>;

export const jobEventsResponse = z.object({ cancelled: z.boolean() });
export type JobEventsResponse = z.infer<typeof jobEventsResponse>;

// ---- heartbeat ---------------------------------------------------------------------------

export const heartbeatRequest = z.object({
  gpu: z
    .object({
      name: shortText(100),
      vramTotalMb: z.number().int().min(0).max(1_000_000),
      vramUsedMb: z.number().int().min(0).max(1_000_000),
      utilizationPct: z.number().min(0).max(100),
      temperatureC: z.number().min(-50).max(150),
    })
    .optional(),
  loadedModels: z
    .array(z.object({ name: modelName, vramMb: z.number().int().min(0).max(1_000_000), expiresAt: shortText(40).optional() }))
    .max(20),
  ollamaVersion: shortText(40).optional(),
});
export type HeartbeatRequest = z.infer<typeof heartbeatRequest>;

export const heartbeatResponse = z.object({ ok: z.literal(true) });

// ---- errors ------------------------------------------------------------------------------

/** Every non-2xx answer of the agent API: a fixed code and a message for the owner. */
export const agentApiError = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export type AgentApiError = z.infer<typeof agentApiError>;
