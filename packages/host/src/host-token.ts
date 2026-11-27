import { readFileSync } from "node:fs";
import { checkOllamaUrl, checkServerUrl, MODEL_NAME, type AgentConfig } from "./config.ts";

// Host token mode: the agent runs with a token made on the website for one host, instead of
// `login` + `register`. Meant for containers (the Docker image) and anything else that starts
// the agent with its settings in the environment.
//
//   aimc_host_<host id: 32 lowercase hex>_<secret: 43 characters base64url>
//
// The host id comes from the token. The token is sent as `Authorization: Bearer <token>` on the
// agent API; it never expires by itself, so there is nothing to refresh. If the server refuses
// it, the owner made a new one (or deleted the host): the agent says so and keeps checking slowly.
//
// Settings from the environment (each one wins over config.json in the settings folder):
//   AIMC_SERVER_URL       the server, https://...
//   AIMC_HOST_TOKEN       the token, or
//   AIMC_HOST_TOKEN_FILE  a file holding it (a Docker secret); wins over AIMC_HOST_TOKEN
//   AIMC_OLLAMA_URL       your Ollama (default http://127.0.0.1:11434)
//   AIMC_MODELS           the Ollama models you offer, comma-separated
//   AIMC_MAX_CONCURRENT   jobs at once (1-32, default 1)
//
// The token is a secret: only its start is ever printed (tokenHint), as the website shows it.

const TOKEN = /^aimc_host_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

export interface HostToken {
  /** The whole token, for the Authorization header only. Never print it. */
  readonly token: string;
  /** The host's id, with dashes. */
  readonly hostId: string;
}

/**
 * What may be printed of a token: aimc_host_ and the first 8 characters of the host id (not
 * secret), as the website's Hosts page shows it, so the two can be matched.
 */
export function tokenHint(token: string): string {
  return `${token.slice(0, 18)}…`;
}

/** 32 hex characters -> 8-4-4-4-12. */
export function hostIdFromHex(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Reads a host token. Surrounding white space (a newline at the end of a file) is ignored. */
export function parseHostToken(raw: string): HostToken {
  const token = raw.trim();
  const match = TOKEN.exec(token);
  if (!match) {
    // Say what's wrong without echoing the secret.
    const hint = !token.startsWith("aimc_host_")
      ? ""
      : token.length === 86
        ? " (it starts aimc_host_ and has the right length, but other characters)"
        : ` (it starts aimc_host_ but has ${token.length} characters, not 86)`;
    throw new Error(
      `That isn't a host token${hint}. A host token looks like aimc_host_<32 hex characters>_<43 characters>; copy it again from the website (Hosts, New token).`,
    );
  }
  return { token, hostId: hostIdFromHex(match[1]!) };
}

export type ReadFileFn = (path: string) => string;

const readText: ReadFileFn = (path) => readFileSync(path, "utf8");

/** Whether the environment asks for host token mode (a token or a token file is set). */
export function tokenModeRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AIMC_HOST_TOKEN?.trim() || env.AIMC_HOST_TOKEN_FILE?.trim());
}

export interface TokenSettings {
  token: HostToken;
  /** Where the token came from, for messages: the variable, and the file if any. */
  from: "AIMC_HOST_TOKEN_FILE" | "AIMC_HOST_TOKEN";
  file?: string;
  /** config.json with the environment on top, and the host id from the token. */
  config: AgentConfig & { hostId: string };
}

/** Reads the token from AIMC_HOST_TOKEN_FILE (preferred) or AIMC_HOST_TOKEN. */
export function readHostToken(env: NodeJS.ProcessEnv, readFile: ReadFileFn = readText): Pick<TokenSettings, "token" | "from" | "file"> {
  const file = env.AIMC_HOST_TOKEN_FILE?.trim();
  if (file) {
    let raw: string;
    try {
      raw = readFile(file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const why =
        code === "ENOENT"
          ? "it doesn't exist"
          : code === "EACCES" || code === "EPERM"
            ? `this agent (user id ${process.getuid?.() ?? "?"}) may not read it; make it readable for that user`
            : (err as Error).message;
      throw new Error(`Can't read the host token from AIMC_HOST_TOKEN_FILE=${file}: ${why}.`);
    }
    try {
      return { token: parseHostToken(raw), from: "AIMC_HOST_TOKEN_FILE", file };
    } catch (err) {
      throw new Error(`AIMC_HOST_TOKEN_FILE (${file}): ${(err as Error).message}`);
    }
  }
  try {
    return { token: parseHostToken(env.AIMC_HOST_TOKEN ?? ""), from: "AIMC_HOST_TOKEN" };
  } catch (err) {
    throw new Error(`AIMC_HOST_TOKEN: ${(err as Error).message}`);
  }
}

/**
 * Host token mode's settings: the token, and config.json with the AIMC_* variables on top.
 * Null when no token is set (the usual `login` mode). Throws, listing every problem at once,
 * when a variable is set but wrong. A missing server or models list is left to the caller
 * (`status` shows it, `start` refuses).
 */
export function loadTokenSettings(env: NodeJS.ProcessEnv, fileConfig: AgentConfig, readFile: ReadFileFn = readText): TokenSettings | null {
  if (!tokenModeRequested(env)) return null;
  const problems: string[] = [];
  const attempt = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (err) {
      problems.push((err as Error).message);
      return undefined;
    }
  };
  const set = (name: string) => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };

  const token = attempt(() => readHostToken(env, readFile));
  const config: AgentConfig = { ...fileConfig };
  const server = set("AIMC_SERVER_URL");
  const named = <T>(name: string, fn: () => T) => () => {
    try {
      return fn();
    } catch (err) {
      throw new Error(`${name}: ${(err as Error).message}`);
    }
  };
  if (server) config.serverUrl = attempt(named("AIMC_SERVER_URL", () => checkServerUrl(server))) ?? config.serverUrl;
  const ollama = set("AIMC_OLLAMA_URL");
  if (ollama) config.ollamaUrl = attempt(named("AIMC_OLLAMA_URL", () => checkOllamaUrl(ollama))) ?? config.ollamaUrl;
  const models = set("AIMC_MODELS");
  if (models !== undefined) {
    const list = [...new Set(models.split(",").map((m) => m.trim()).filter(Boolean))];
    const bad = list.filter((m) => !MODEL_NAME.test(m));
    if (bad.length) problems.push(`AIMC_MODELS: not a model name: ${bad.join(", ")}. Model names look like gemma3:12b (letters, digits, . _ : / -).`);
    else config.models = list;
  }
  const max = set("AIMC_MAX_CONCURRENT");
  if (max !== undefined) {
    const n = Number(max);
    if (!Number.isInteger(n) || n < 1 || n > 32) problems.push(`AIMC_MAX_CONCURRENT must be a whole number from 1 to 32 (got ${max}).`);
    else config.maxConcurrent = n;
  }
  if (problems.length || !token) {
    throw new Error(`Host token mode: the settings in the environment aren't right:\n  - ${problems.join("\n  - ")}`);
  }
  return { ...token, config: { ...config, hostId: token.token.hostId } };
}

/**
 * The bearer token in host token mode. It never changes by itself; after the server refuses it,
 * `reload` reads the token file again (the owner may have put a new token there).
 */
export class HostTokenSource {
  readonly refreshable = false;
  private current: HostToken;
  private readonly reader: (() => HostToken) | null;

  /** `reader`: reads the token again (from AIMC_HOST_TOKEN_FILE); null when it can't change (AIMC_HOST_TOKEN). */
  constructor(token: HostToken, reader: (() => HostToken) | null = null) {
    this.current = token;
    this.reader = reader;
  }

  get(): Promise<string> {
    return Promise.resolve(this.current.token);
  }

  invalidate(): void {
    // Nothing to refresh: the runner waits and calls reload().
  }

  hint(): string {
    return tokenHint(this.current.token);
  }

  get canReload(): boolean {
    return this.reader !== null;
  }

  /**
   * Reads the token file again. True when it holds a new token for this host. A token for
   * another host throws: the agent must restart to become that host.
   */
  reload(): boolean {
    if (!this.reader) return false;
    let next: HostToken;
    try {
      next = this.reader();
    } catch {
      return false; // being rewritten, or broken: keep the old one, look again later
    }
    if (next.token === this.current.token) return false;
    if (next.hostId !== this.current.hostId) {
      throw new HostTokenChangedError(`The token file now holds a token for another host (${next.hostId}, was ${this.current.hostId}). Restart the agent to switch hosts.`);
    }
    this.current = next;
    return true;
  }
}

export class HostTokenChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostTokenChangedError";
  }
}
