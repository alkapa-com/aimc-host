import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "./config.ts";
import { fakeFetch, json } from "./fake-fetch.ts";
import { HostTokenChangedError, HostTokenSource, hostIdFromHex, loadTokenSettings, parseHostToken, readHostToken, tokenHint, tokenModeRequested } from "./host-token.ts";
import { earlierLifeOfThisPid, RunFile, readRun, type RunInfo } from "./instance.ts";
import { OllamaClient } from "./ollama.ts";
import { Runner } from "./runner.ts";
import { ServerClient, ServerError } from "./server-client.ts";
import { updateCommand } from "./version.ts";

// Host token mode: aimc_host_<host id hex>_<secret>, settings from AIMC_* variables.

const HEX = "0123456789abcdef0123456789abcdef";
const HOST = "01234567-89ab-cdef-0123-456789abcdef";
const SECRET = "Ab3_-xYz0123456789abcdefghijklmnopqrstuvwxy"; // 43 characters, base64url
const TOKEN = `aimc_host_${HEX}_${SECRET}`;
const OTHER_HEX = "fedcba9876543210fedcba9876543210";

const defaults: AgentConfig = { ollamaUrl: "http://127.0.0.1:11434", models: [], maxConcurrent: 1 };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aimc-token-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the token", () => {
  it("gives the host id, with dashes", () => {
    expect(SECRET).toHaveLength(43);
    expect(parseHostToken(TOKEN)).toEqual({ token: TOKEN, hostId: HOST });
    expect(hostIdFromHex(HEX)).toBe(HOST);
  });

  it("ignores white space around it (a newline at the end of a file)", () => {
    expect(parseHostToken(`  ${TOKEN}\r\n`).token).toBe(TOKEN);
  });

  it("accepts _ and - in the secret (base64url)", () => {
    const secret = "_".repeat(21) + "-".repeat(22);
    expect(parseHostToken(`aimc_host_${HEX}_${secret}`).hostId).toBe(HOST);
  });

  it("refuses anything else, without repeating the secret", () => {
    const bad = [
      "",
      SECRET,
      `aimc_host_${HEX.toUpperCase()}_${SECRET}`, // the id is lowercase
      `aimc_host_${HEX.slice(1)}_${SECRET}`, // 31 hex
      `aimc_host_${HEX}_${SECRET.slice(1)}`, // 42 characters
      `aimc_host_${HEX}_${SECRET}x`, // 44
      `aimc_host_${HEX}_${SECRET.slice(0, 42)}=`, // not base64url
      `sk-${TOKEN}`,
      `aimc_host_${HOST}_${SECRET}`, // dashes in the id
    ];
    for (const raw of bad) {
      const err = (() => {
        try {
          parseHostToken(raw);
          return null;
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err, raw).toBeInstanceOf(Error);
      expect(err!.message).not.toContain(SECRET.slice(0, 20));
      expect(err!.message).toContain("aimc_host_<32 hex characters>");
    }
  });

  it("is shown only by its start, as the website shows it (no part of the secret)", () => {
    expect(tokenHint(TOKEN)).toBe("aimc_host_01234567…");
  });
});

describe("settings from the environment", () => {
  const env = (over: Record<string, string>) => ({ AIMC_SERVER_URL: "https://aimc.example", AIMC_HOST_TOKEN: TOKEN, ...over });

  it("is off without a token (the login mode)", () => {
    expect(tokenModeRequested({})).toBe(false);
    expect(tokenModeRequested({ AIMC_HOST_TOKEN: " " })).toBe(false);
    expect(loadTokenSettings({ AIMC_SERVER_URL: "https://aimc.example", AIMC_MODELS: "a" }, defaults)).toBeNull();
  });

  it("reads the token, server, Ollama, models and jobs at once", () => {
    const settings = loadTokenSettings(
      env({ AIMC_OLLAMA_URL: "http://ollama:11434/", AIMC_MODELS: " gemma3:12b, llama3.2:3b,,gemma3:12b ", AIMC_MAX_CONCURRENT: "2" }),
      defaults,
    )!;
    expect(settings.from).toBe("AIMC_HOST_TOKEN");
    expect(settings.token.token).toBe(TOKEN);
    expect(settings.config).toEqual({
      serverUrl: "https://aimc.example",
      ollamaUrl: "http://ollama:11434",
      models: ["gemma3:12b", "llama3.2:3b"],
      maxConcurrent: 2,
      hostId: HOST,
    });
  });

  it("falls back to config.json for what isn't set, but the host id is always the token's", () => {
    const file: AgentConfig = { serverUrl: "https://old.example", ollamaUrl: "http://10.0.0.5:11434", models: ["qwen3:8b"], maxConcurrent: 3, hostId: "11111111-2222-4333-8444-555555555555" };
    const settings = loadTokenSettings({ AIMC_HOST_TOKEN: TOKEN }, file)!;
    expect(settings.config).toEqual({ ...file, hostId: HOST });
  });

  it("leaves a missing server or models to the caller", () => {
    const settings = loadTokenSettings({ AIMC_HOST_TOKEN: TOKEN }, defaults)!;
    expect(settings.config.serverUrl).toBeUndefined();
    expect(settings.config.models).toEqual([]);
  });

  it("prefers the token file, and reads it once more when asked", async () => {
    const path = join(dir, "token");
    await writeFile(path, `${TOKEN}\n`);
    const settings = loadTokenSettings(env({ AIMC_HOST_TOKEN: "something else", AIMC_HOST_TOKEN_FILE: path }), defaults)!;
    expect(settings).toMatchObject({ from: "AIMC_HOST_TOKEN_FILE", file: path, token: { token: TOKEN, hostId: HOST } });
  });

  it("says plainly when the token file is missing or unreadable", () => {
    const missing = join(dir, "nope");
    expect(() => readHostToken({ AIMC_HOST_TOKEN_FILE: missing })).toThrow(`AIMC_HOST_TOKEN_FILE=${missing}: it doesn't exist`);
    const denied = () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    expect(() => readHostToken({ AIMC_HOST_TOKEN_FILE: "/run/secrets/t" }, denied)).toThrow(/may not read it/);
  });

  it("lists every problem at once, and never the token", () => {
    const bad = `aimc_host_${HEX}_short-secret`;
    let message = "";
    try {
      loadTokenSettings(env({ AIMC_HOST_TOKEN: bad, AIMC_SERVER_URL: "http://aimc.example", AIMC_MODELS: "ok:1b,bad model", AIMC_MAX_CONCURRENT: "0" }), defaults);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("AIMC_HOST_TOKEN: That isn't a host token");
    expect(message).toContain("AIMC_SERVER_URL: The server URL must start with https://");
    expect(message).toContain("AIMC_MODELS: not a model name: bad model");
    expect(message).toContain("AIMC_MAX_CONCURRENT must be a whole number from 1 to 32 (got 0)");
    expect(message).not.toContain("short-secret");
  });

  it("refuses jobs at once outside 1-32 and non-numbers", () => {
    for (const n of ["33", "1.5", "two", "-1"]) expect(() => loadTokenSettings(env({ AIMC_MAX_CONCURRENT: n }), defaults), n).toThrow(/AIMC_MAX_CONCURRENT/);
  });
});

describe("the token source", () => {
  const other = `aimc_host_${HEX}_${"N".repeat(43)}`;

  it("can't be refreshed, and is reloaded from the file only", async () => {
    const fixed = new HostTokenSource(parseHostToken(TOKEN));
    expect(fixed.refreshable).toBe(false);
    expect(await fixed.get()).toBe(TOKEN);
    expect(fixed.canReload).toBe(false);
    expect(fixed.reload()).toBe(false);
  });

  it("takes a new token for the same host from the file", async () => {
    let content = TOKEN;
    const source = new HostTokenSource(parseHostToken(TOKEN), () => parseHostToken(content));
    expect(source.reload()).toBe(false); // unchanged
    content = "half-written";
    expect(source.reload()).toBe(false); // broken: keep the old one
    expect(await source.get()).toBe(TOKEN);
    content = other;
    expect(source.reload()).toBe(true);
    expect(await source.get()).toBe(other);
  });

  it("refuses to become another host without a restart", () => {
    const source = new HostTokenSource(parseHostToken(TOKEN), () => parseHostToken(`aimc_host_${OTHER_HEX}_${SECRET}`));
    expect(() => source.reload()).toThrow(HostTokenChangedError);
  });
});

describe("the agent with a host token", () => {
  it("sends the token as is, and doesn't retry a refused one at once", async () => {
    const server = fakeFetch(() => () => json({ error: { code: "invalid_token", message: "This host token isn't valid." } }, 401));
    const client = new ServerClient(server.fetch, "https://aimc.test", new HostTokenSource(parseHostToken(TOKEN)), "run-1");
    const err = await client.heartbeat(HOST, { loadedModels: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect(err).toMatchObject({ status: 401, code: "invalid_token" });
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.url).toBe(`https://aimc.test/api/agent/v1/hosts/${HOST}/heartbeat`);
    expect(server.calls[0]!.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "aimc-run-id": "run-1" });
  });

  it("says once that the token was refused, keeps checking, and picks up a new token from the file", async () => {
    const newToken = `aimc_host_${HEX}_${"Q".repeat(43)}`;
    let fileContent = TOKEN;
    const hellos: { auth: string; body: Record<string, unknown> }[] = [];
    const server = fakeFetch((_method, path) => {
      if (path.endsWith("/hello")) {
        return (_url, init) => {
          const auth = (init.headers as Record<string, string>).authorization!;
          hellos.push({ auth, body: JSON.parse(init.body as string) as Record<string, unknown> });
          if (auth !== `Bearer ${newToken}`) return json({ error: { code: "invalid_token", message: "This host token isn't valid any more." } }, 401);
          return json({ status: "pending_approval", maxConcurrent: 1, heartbeatIntervalMs: 60_000 });
        };
      }
      return () => json({ ok: true });
    });
    const ollama = fakeFetch((_method, path) => (path === "/api/version" ? () => json({ version: "0.40.16" }) : undefined));
    const logs: string[] = [];
    const states: string[] = [];
    const stop = new AbortController();
    const source = new HostTokenSource(parseHostToken(TOKEN), () => parseHostToken(fileContent));
    const running = new Runner({
      server: new ServerClient(server.fetch, "https://aimc.test", source),
      ollama: new OllamaClient(ollama.fetch, "http://127.0.0.1:11434"),
      hostId: HOST,
      models: ["gemma3:12b"],
      maxConcurrent: 1,
      agentVersion: "0.5.0-test",
      readGpu: async () => null,
      log: (m) => logs.push(m),
      signal: stop.signal,
      idleRetryMs: 10_000,
      hostToken: source,
      tokenRetryMs: 30,
      tokenCheckMs: 10,
      onState: (s) => states.push(s),
    }).run();

    const until = async (check: () => boolean) => {
      const end = Date.now() + 2000;
      while (!check()) {
        if (Date.now() > end) throw new Error("timed out waiting");
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    await until(() => hellos.length >= 3); // refused, then tried again after tokenRetryMs
    const refusals = logs.filter((l) => l.includes("refused the host token"));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("aimc_host_01234567…");
    expect(refusals[0]).toContain("put it into the token file");
    expect(states).toContain("token_refused");
    for (const line of logs) expect(line).not.toContain(SECRET);

    fileContent = newToken;
    await until(() => states.includes("waiting_for_approval"));
    expect(logs.some((l) => l.includes("Read a new host token"))).toBe(true);
    expect(hellos.at(-1)!.auth).toBe(`Bearer ${newToken}`);
    expect(hellos.every((h) => !("machineId" in h.body))).toBe(true);
    stop.abort();
    await running;
  });

  it("tells a container how to update", () => {
    expect(updateCommand("0.5.0", { AIMC_CONTAINER: "1", AIMC_IMAGE: "example/aimc-host" }, "linux")).toContain("example/aimc-host:0.5.0");
    expect(updateCommand("0.5.0", { AIMC_CONTAINER: "1", AIMC_SERVICE: "1" }, "linux")).toContain("docker compose pull");
  });
});

describe("restarted containers", () => {
  const info = (over: Partial<RunInfo>): RunInfo => ({
    pid: 1,
    runId: "r",
    mode: "container",
    hostId: HOST,
    version: "0.5.0",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    state: "connected",
    jobsDone: 0,
    ...over,
  });

  it("knows a run file from an earlier life of its own pid", () => {
    const now = Date.now();
    expect(earlierLifeOfThisPid(info({}), 1, now)).toBe(true);
    expect(earlierLifeOfThisPid(info({ pid: 7 }), 1, now)).toBe(false);
    expect(earlierLifeOfThisPid(info({ startedAt: new Date(now).toISOString() }), 1, now - 5000)).toBe(false);
  });

  it("takes over the run file its previous run left in the volume", async () => {
    const stale = info({ pid: process.pid, startedAt: new Date(Date.now() - process.uptime() * 1000 - 60_000).toISOString() });
    await writeFile(join(dir, "run.json"), JSON.stringify(stale));
    const run = await RunFile.acquire(dir, { pid: process.pid, runId: "new", mode: "container", hostId: HOST, version: "0.5.0" });
    expect((await readRun(dir))?.runId).toBe("new");
    await run.release();
  });
});
