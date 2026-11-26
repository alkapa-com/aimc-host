import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobEvent } from "aimc-protocol/agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceLogin, logout, NotSignedInError, TokenSource } from "./auth.ts";
import { AgentFiles, checkServerUrl, configDir } from "./config.ts";
import { controlledStream, fakeFetch, json } from "./fake-fetch.ts";
import { OllamaClient, OllamaError } from "./ollama.ts";
import { parseNvidiaSmi } from "./telemetry.ts";

const ISSUER = "https://sign-in.test/realms/main";
const SERVER = "https://aimc.test";
const DISCOVERY = {
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
  device_authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth/device`,
  revocation_endpoint: `${ISSUER}/protocol/openid-connect/revoke`,
};

let dir: string;
let files: AgentFiles;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "amc-agent-"));
  files = new AgentFiles(join(dir, "ai-my-card-host"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("config", () => {
  it("lives in %APPDATA% on Windows and ~/.config on Linux", () => {
    expect(configDir({ APPDATA: "C:\\Users\\bob\\AppData\\Roaming" }, "win32")).toBe(join("C:\\Users\\bob\\AppData\\Roaming", "ai-my-card-host"));
    expect(configDir({ XDG_CONFIG_HOME: "/home/bob/.config" }, "linux")).toBe(join("/home/bob/.config", "ai-my-card-host"));
  });

  it("accepts https servers, and http only for this machine", () => {
    expect(checkServerUrl("https://gpu.example.com/")).toBe("https://gpu.example.com");
    expect(checkServerUrl("http://localhost:3200")).toBe("http://localhost:3200");
    for (const bad of ["http://gpu.example.com", "ftp://x", "https://u:p@x.com", "https://x.com/?a=1", "nope"]) {
      expect(() => checkServerUrl(bad), bad).toThrow();
    }
  });

  it("saves and loads, with defaults, and keeps the sign-in private on Linux", async () => {
    expect(await files.loadConfig()).toEqual({ ollamaUrl: "http://127.0.0.1:11434", models: [], maxConcurrent: 1 });
    await files.saveConfig({ serverUrl: SERVER, ollamaUrl: "http://127.0.0.1:11434", models: ["gemma3:12b"], maxConcurrent: 2 });
    expect((await files.loadConfig()).models).toEqual(["gemma3:12b"]);
    await files.saveCredentials({ issuer: ISSUER, clientId: "ai-my-card-host-agent", refreshToken: "secret" });
    if (process.platform !== "win32") {
      expect((await stat(files.credentialsPath())).mode & 0o777).toBe(0o600);
      expect((await stat(files.dir)).mode & 0o777).toBe(0o700);
    }
    await files.deleteCredentials();
    expect(await files.loadCredentials()).toBeNull();
  });
});

describe("device-flow login", () => {
  function signInServer(polls: unknown[]) {
    let poll = 0;
    return fakeFetch((method, path) => {
      if (path === "/api/agent/v1/config") return () => json({ issuer: ISSUER, clientId: "ai-my-card-host-agent", scope: "openid offline_access host", protocolVersion: 1 });
      if (path.endsWith("/.well-known/openid-configuration")) return () => json(DISCOVERY);
      if (path.endsWith("/auth/device")) {
        return () => json({ device_code: "dev-123", user_code: "ABCD-EFGH", verification_uri: `${ISSUER}/device`, verification_uri_complete: `${ISSUER}/device?user_code=ABCD-EFGH`, expires_in: 600, interval: 5 });
      }
      if (path.endsWith("/token")) {
        return () => {
          const answer = polls[Math.min(poll++, polls.length - 1)] as { status?: number };
          return json(answer, answer.status ?? (Object.hasOwn(answer, "error") ? 400 : 200));
        };
      }
      return undefined;
    });
  }

  it("shows the code, polls patiently (slowing down when asked) and returns the refresh token", async () => {
    const f = signInServer([{ error: "authorization_pending" }, { error: "slow_down" }, { access_token: "a", refresh_token: "r-1", expires_in: 300 }]);
    const waits: number[] = [];
    let shown = "";
    const creds = await deviceLogin({ fetchFn: f.fetch, serverUrl: SERVER, show: (p) => (shown = p.userCode), sleep: async (ms) => void waits.push(ms) });
    expect(shown).toBe("ABCD-EFGH");
    expect(creds).toEqual({ issuer: ISSUER, clientId: "ai-my-card-host-agent", refreshToken: "r-1" });
    expect(waits).toEqual([5000, 5000, 10000]);
    const start = f.calls.find((c) => c.url.endsWith("/auth/device"))!;
    expect(start.body).toEqual({ client_id: "ai-my-card-host-agent", scope: "openid offline_access host" });
    const polls = f.calls.filter((c) => c.url.endsWith("/token"));
    expect(polls[0]!.body).toMatchObject({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "dev-123" });
  });

  it("stops with a clear message when declined or expired", async () => {
    const sleep = async () => {};
    await expect(deviceLogin({ fetchFn: signInServer([{ error: "access_denied" }]).fetch, serverUrl: SERVER, show: () => {}, sleep })).rejects.toThrow("declined");
    await expect(deviceLogin({ fetchFn: signInServer([{ error: "expired_token" }]).fetch, serverUrl: SERVER, show: () => {}, sleep })).rejects.toThrow("expired");
  });

  it("refreshes access tokens, saves a rotated refresh token, and explains an ended sign-in", async () => {
    await files.saveCredentials({ issuer: ISSUER, clientId: "ai-my-card-host-agent", refreshToken: "r-1" });
    let answer: unknown = { access_token: "a-1", refresh_token: "r-2", expires_in: 300 };
    const f = fakeFetch((_m, path) =>
      path.endsWith("/.well-known/openid-configuration") ? () => json(DISCOVERY) : path.endsWith("/token") ? () => json(answer, Object.hasOwn(answer as object, "error") ? 400 : 200) : undefined,
    );
    const tokens = new TokenSource(f.fetch, files);
    expect(await tokens.get()).toBe("a-1");
    expect(await tokens.get()).toBe("a-1"); // cached while valid
    expect(f.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
    expect((await files.loadCredentials())!.refreshToken).toBe("r-2");

    answer = { error: "invalid_grant" };
    tokens.invalidate();
    await expect(tokens.get()).rejects.toBeInstanceOf(NotSignedInError);
  });

  it("logout revokes the refresh token, then deletes the file", async () => {
    await files.saveCredentials({ issuer: ISSUER, clientId: "ai-my-card-host-agent", refreshToken: "r-9" });
    const f = fakeFetch((_m, path) =>
      path.endsWith("/.well-known/openid-configuration") ? () => json(DISCOVERY) : path.endsWith("/revoke") ? () => new Response(null, { status: 200 }) : undefined,
    );
    expect(await logout(f.fetch, files)).toEqual({ revoked: true, wasSignedIn: true });
    expect(f.calls.find((c) => c.url.endsWith("/revoke"))!.body).toEqual({ token: "r-9", token_type_hint: "refresh_token", client_id: "ai-my-card-host-agent" });
    expect(await files.loadCredentials()).toBeNull();
    expect(await logout(f.fetch, files)).toEqual({ revoked: false, wasSignedIn: false });
  });
});

describe("Ollama bridge", () => {
  const job: JobEvent = {
    type: "job",
    jobId: "6f2a1b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b",
    model: "gemma3:12b",
    messages: [{ role: "user", content: "Total?", images: ["aW1n"] }],
    options: { numPredict: 64, temperature: 0, topP: 0.9, stop: ["###"], seed: 7, format: { type: "object" }, think: false, numCtx: 12288 },
    deadlineMs: 60_000,
  };

  it("sends the job as Ollama's /api/chat and turns its NDJSON into events", async () => {
    const f = fakeFetch((_m, path) =>
      path === "/api/chat"
        ? () =>
            new Response(
              [
                '{"message":{"content":"{\\"total\\":"}}',
                '{"message":{"content":"10.6}"}}',
                '{"done":true,"done_reason":"stop","prompt_eval_count":1061,"eval_count":9,"load_duration":3000000,"prompt_eval_duration":250000000,"eval_duration":90000000}',
              ].join("\n"),
            )
        : undefined,
    );
    const events = [];
    for await (const e of new OllamaClient(f.fetch, "http://127.0.0.1:11434").chat(job, new AbortController().signal)) events.push(e);
    expect(f.calls[0]!.body).toEqual({
      model: "gemma3:12b",
      messages: [{ role: "user", content: "Total?", images: ["aW1n"] }],
      stream: true,
      format: { type: "object" },
      think: false,
      options: { num_predict: 64, temperature: 0, top_p: 0.9, stop: ["###"], seed: 7, num_ctx: 12288 },
    });
    expect(events).toEqual([
      { type: "delta", text: '{"total":' },
      { type: "delta", text: "10.6}" },
      { type: "done", finishReason: "stop", usage: { promptTokens: 1061, completionTokens: 9 }, timings: { loadMs: 3, promptEvalMs: 250, evalMs: 90 } },
    ]);
  });

  it("names Ollama's refusals: thinking not supported, unreachable", async () => {
    const refusing = fakeFetch(() => () => json({ error: '"gemma3:12b" does not support thinking' }, 400));
    const run = async (client: OllamaClient) => {
      for await (const _ of client.chat({ ...job, options: { numPredict: 5, think: true } }, new AbortController().signal)) void _;
    };
    await expect(run(new OllamaClient(refusing.fetch, "http://127.0.0.1:11434"))).rejects.toMatchObject({ code: "thinking_not_supported" });
    const blind = fakeFetch(() => () => json({ error: "Multimodal data provided, but model does not support multimodal requests." }, 400));
    await expect(run(new OllamaClient(blind.fetch, "http://127.0.0.1:11434"))).rejects.toMatchObject({ code: "images_not_supported" });
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(run(new OllamaClient(down, "http://127.0.0.1:11434"))).rejects.toBeInstanceOf(OllamaError);
    await expect(run(new OllamaClient(down, "http://127.0.0.1:11434"))).rejects.toMatchObject({ code: "ollama_unreachable" });
  });

  it("only ever calls chat, tags, ps and version", async () => {
    const f = fakeFetch((_m, path) => () => (path === "/api/ps" ? json({ models: [{ name: "gemma3:12b", size_vram: 8 * 1024 * 1024 * 1024 }] }) : json({ version: "0.40.16", models: [{ name: "gemma3:12b" }] })));
    const ollama = new OllamaClient(f.fetch, "http://127.0.0.1:11434/");
    expect(await ollama.version()).toBe("0.40.16");
    expect(await ollama.installed()).toEqual(["gemma3:12b"]);
    expect(await ollama.loaded()).toEqual([{ name: "gemma3:12b", vramMb: 8192 }]);
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/version", "/api/tags", "/api/ps"]);
  });

  it("stops generating when aborted", async () => {
    let stream!: ReturnType<typeof controlledStream>;
    const f = fakeFetch(() => (_url, init) => {
      stream = controlledStream(init.signal);
      return new Response(stream.body);
    });
    const abort = new AbortController();
    const seen: string[] = [];
    const done = (async () => {
      for await (const e of new OllamaClient(f.fetch, "http://x").chat(job, abort.signal)) if (e.type === "delta") seen.push(e.text);
    })();
    await new Promise((r) => setTimeout(r, 5));
    stream.write('{"message":{"content":"Hi"}}\n');
    await new Promise((r) => setTimeout(r, 5));
    abort.abort();
    await expect(done).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual(["Hi"]);
  });
});

describe("GPU telemetry", () => {
  it("parses nvidia-smi's CSV and ignores garbage", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 4070, 12282, 7012, 3, 41\n")).toEqual({
      name: "NVIDIA GeForce RTX 4070",
      vramTotalMb: 12282,
      vramUsedMb: 7012,
      utilizationPct: 3,
      temperatureC: 41,
    });
    expect(parseNvidiaSmi("")).toBeNull();
    expect(parseNvidiaSmi("No devices were found")).toBeNull();
    expect(parseNvidiaSmi("GPU, [N/A], 1, 2, 3")).toBeNull();
  });
});

describe("token claims for status", () => {
  const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

  it("reads aud, scope and client, and explains what the agent API would refuse", async () => {
    const { readTokenClaims, tokenProblems } = await import("./auth.ts");
    const good = readTokenClaims(jwt({ aud: ["ai-my-card-host-api", "account"], scope: "openid offline_access host", azp: "ai-my-card-host-agent", sub: "u1" }))!;
    expect(good).toEqual({ aud: ["ai-my-card-host-api", "account"], scope: ["openid", "offline_access", "host"], azp: "ai-my-card-host-agent", sub: "u1" });
    expect(tokenProblems(good)).toEqual([]);

    const noMapper = readTokenClaims(jwt({ aud: "account", scope: "openid host" }))!;
    expect(tokenProblems(noMapper)).toEqual([expect.stringContaining("host API audience")]);

    const both = readTokenClaims(jwt({ aud: ["ai-my-card-host-api", "ai-my-card-api"], scope: "openid host inference" }))!;
    expect(tokenProblems(both)).toEqual([expect.stringContaining("inference API audience")]);

    expect(readTokenClaims("not-a-jwt")).toBeNull();
  });
});
