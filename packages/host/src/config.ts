import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// The agent keeps two files in its own folder:
//   config.json       server URL, Ollama URL, offered models, jobs at once, the host id
//   credentials.json  the refresh token from `login`: a SECRET, like a password
// Windows: %APPDATA%\ai-my-card-host. Linux: ~/.config/ai-my-card-host, readable only by you
// (folder 700, files 600).

export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "ai-my-card-host");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ai-my-card-host");
}

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

export const agentConfig = z.object({
  serverUrl: z.string().optional(),
  ollamaUrl: z.string().default(DEFAULT_OLLAMA_URL),
  /** Local Ollama models you offer. Only these are ever run. */
  models: z.array(z.string().regex(MODEL_NAME)).default([]),
  /** Jobs at once on this machine. The server may give fewer (its own limit for your host). */
  maxConcurrent: z.number().int().min(1).max(32).default(1),
  hostId: z.uuid().optional(),
});
export type AgentConfig = z.infer<typeof agentConfig>;

export const credentials = z.object({
  issuer: z.string(),
  clientId: z.string(),
  refreshToken: z.string(),
});
export type Credentials = z.infer<typeof credentials>;

/**
 * The server must be HTTPS. Plain http only for this machine (local development), so the
 * tokens and your users' prompts never cross a network unencrypted.
 */
export function checkServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Not a URL: ${raw}`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("The server URL must start with https:// (plain http only for localhost).");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("The server URL must be a plain address, like https://your-server.example");
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/**
 * Where your Ollama listens: this machine by default, or another machine on your network. It is
 * only ever called by this agent; keep it bound to localhost or your LAN, never the internet.
 */
export function checkOllamaUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The Ollama URL must start with http://");
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export class AgentFiles {
  readonly dir: string;
  readonly platform: NodeJS.Platform;

  constructor(dir: string = configDir(), platform: NodeJS.Platform = process.platform) {
    this.dir = dir;
    this.platform = platform;
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  private async readJson(name: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.path(name), "utf8")) as unknown;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`Couldn't read ${this.path(name)}: ${(err as Error).message}`);
    }
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = this.path(name);
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    if (this.platform !== "win32") {
      // mode only applies when the file is created; make sure an older file is private too.
      await chmod(this.dir, 0o700);
      await chmod(file, 0o600);
    }
  }

  async loadConfig(): Promise<AgentConfig> {
    const raw = await this.readJson("config.json");
    const parsed = agentConfig.safeParse(raw ?? {});
    if (!parsed.success) throw new Error(`${this.path("config.json")} is not valid. Fix or delete it.`);
    return parsed.data;
  }

  saveConfig(config: AgentConfig): Promise<void> {
    return this.writeJson("config.json", config);
  }

  async loadCredentials(): Promise<Credentials | null> {
    const raw = await this.readJson("credentials.json");
    if (raw === null) return null;
    const parsed = credentials.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  saveCredentials(value: Credentials): Promise<void> {
    return this.writeJson("credentials.json", value);
  }

  async deleteCredentials(): Promise<void> {
    await rm(this.path("credentials.json"), { force: true });
  }

  credentialsPath(): string {
    return this.path("credentials.json");
  }
}
