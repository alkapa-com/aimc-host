import { agentConfigResponse, type AgentConfigResponse } from "aimc-protocol/agent";
import type { AgentFiles, Credentials } from "./config.ts";

// Signing in without a browser on this machine: the OAuth 2.0 Device Authorization Grant.
//
//   1. The agent asks the sign-in server (OpenID Connect) for a device code and a short user code.
//   2. You open the link on any device (your phone works), sign in, and confirm the code.
//   3. Meanwhile the agent polls the sign-in server, which answers "pending" until you confirm, then gives
//      an access token (5 minutes) and a refresh token (offline_access: lasts as long as it's
//      used at least every 30 days, until you log out or an admin revokes it).
//
// The agent discovers where the sign-in server is and which client to use from the server itself
// (GET /api/agent/v1/config), so the server URL is all you configure.

export type FetchFn = typeof fetch;

interface Discovery {
  token_endpoint: string;
  device_authorization_endpoint: string;
  revocation_endpoint?: string;
}

async function getJson(fetchFn: FetchFn, url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetchFn(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  return { status: res.status, body };
}

export async function fetchServerConfig(fetchFn: FetchFn, serverUrl: string): Promise<AgentConfigResponse> {
  let result;
  try {
    result = await getJson(fetchFn, `${serverUrl}/api/agent/v1/config`);
  } catch (err) {
    throw new Error(`Can't reach ${serverUrl}: ${(err as Error).message}`);
  }
  const parsed = agentConfigResponse.safeParse(result.body);
  if (result.status !== 200 || !parsed.success) throw new Error(`${serverUrl} doesn't look like an aimc server (GET /api/agent/v1/config).`);
  return parsed.data;
}

async function discover(fetchFn: FetchFn, issuer: string): Promise<Discovery> {
  const { status, body } = await getJson(fetchFn, `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
  const doc = body as Partial<Discovery> | null;
  if (status !== 200 || !doc?.token_endpoint || !doc.device_authorization_endpoint) {
    throw new Error("The sign-in server doesn't offer device sign-in. Ask the admin to enable it for the host agent client.");
  }
  return doc as Discovery;
}

const form = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

export interface DeviceLoginPrompt {
  verificationUri: string;
  verificationUriComplete: string | null;
  userCode: string;
  expiresInSec: number;
}

/**
 * The whole device flow. `show` tells the user where to go; `sleep` is injectable for tests.
 * Returns the credentials to store (never printed).
 */
export async function deviceLogin(opts: {
  fetchFn: FetchFn;
  serverUrl: string;
  show: (prompt: DeviceLoginPrompt) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Credentials> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const config = await fetchServerConfig(opts.fetchFn, opts.serverUrl);
  const endpoints = await discover(opts.fetchFn, config.issuer);

  const start = await getJson(opts.fetchFn, endpoints.device_authorization_endpoint, form({ client_id: config.clientId, scope: config.scope }));
  const device = start.body as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
  } | null;
  if (start.status !== 200 || !device?.device_code || !device.user_code || !device.verification_uri) {
    const error = device?.error ?? `HTTP ${start.status}`;
    const hint =
      error === "invalid_client" || error === "unauthorized_client"
        ? ` The host agent client "${config.clientId}" doesn't exist or doesn't allow device sign-in yet: ask the server's admin.`
        : "";
    throw new Error(`The sign-in server refused to start a device sign-in (${error}).${hint}`);
  }
  opts.show({
    verificationUri: device.verification_uri,
    verificationUriComplete: device.verification_uri_complete ?? null,
    userCode: device.user_code,
    expiresInSec: device.expires_in ?? 600,
  });

  let intervalMs = Math.max(1, device.interval ?? 5) * 1000;
  const deadline = Date.now() + (device.expires_in ?? 600) * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const poll = await getJson(
      opts.fetchFn,
      endpoints.token_endpoint,
      form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: config.clientId }),
    );
    const body = poll.body as { refresh_token?: string; error?: string } | null;
    if (poll.status === 200 && body?.refresh_token) {
      return { issuer: config.issuer, clientId: config.clientId, refreshToken: body.refresh_token };
    }
    switch (body?.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += 5000; // the server asks us to poll less often
        continue;
      case "access_denied":
        throw new Error("The sign-in was declined.");
      case "expired_token":
        throw new Error("The code expired before it was confirmed. Run `login` again.");
      default:
        throw new Error(`The sign-in failed (${body?.error ?? `HTTP ${poll.status}`}).`);
    }
  }
  throw new Error("The code expired before it was confirmed. Run `login` again.");
}

export class NotSignedInError extends Error {
  constructor(message = "Not signed in. Run `login` first.") {
    super(message);
    this.name = "NotSignedInError";
  }
}

/**
 * Hands out access tokens, refreshing them shortly before they expire. The sign-in server may send a new
 * refresh token with each refresh ("rotation"); it is saved at once, so a restart keeps working.
 */
export class TokenSource {
  private readonly fetchFn: FetchFn;
  private readonly files: AgentFiles;
  private creds: Credentials | null = null;
  private access: { token: string; expiresAt: number } | null = null;
  private endpoints: Discovery | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(fetchFn: FetchFn, files: AgentFiles) {
    this.fetchFn = fetchFn;
    this.files = files;
  }

  /** A valid access token (refreshed when less than 30 seconds are left). */
  async get(): Promise<string> {
    if (this.access && this.access.expiresAt - Date.now() > 30_000) return this.access.token;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Forget the current access token (the server refused it): the next get() refreshes. */
  invalidate(): void {
    this.access = null;
  }

  private async refresh(): Promise<string> {
    this.creds ??= await this.files.loadCredentials();
    if (!this.creds) throw new NotSignedInError();
    this.endpoints ??= await discover(this.fetchFn, this.creds.issuer);
    const { status, body } = await getJson(
      this.fetchFn,
      this.endpoints.token_endpoint,
      form({ grant_type: "refresh_token", refresh_token: this.creds.refreshToken, client_id: this.creds.clientId }),
    );
    const tokens = body as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string } | null;
    if (status !== 200 || !tokens?.access_token) {
      if (tokens?.error === "invalid_grant") {
        throw new NotSignedInError("Your sign-in has ended (logged out, expired or revoked by an admin). Run `login` again.");
      }
      throw new Error(`Couldn't refresh the sign-in (${tokens?.error ?? `HTTP ${status}`}).`);
    }
    if (tokens.refresh_token && tokens.refresh_token !== this.creds.refreshToken) {
      this.creds = { ...this.creds, refreshToken: tokens.refresh_token };
      await this.files.saveCredentials(this.creds);
    }
    this.access = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in ?? 300) * 1000 };
    return tokens.access_token;
  }
}

/**
 * Logs out: revokes the refresh token at the sign-in server (so a copy of the file is useless too), then
 * deletes the local file. The file is deleted even if the sign-in server can't be reached.
 */
export async function logout(fetchFn: FetchFn, files: AgentFiles): Promise<{ revoked: boolean; wasSignedIn: boolean }> {
  const creds = await files.loadCredentials();
  if (!creds) return { revoked: false, wasSignedIn: false };
  let revoked = false;
  try {
    const endpoints = await discover(fetchFn, creds.issuer);
    if (endpoints.revocation_endpoint) {
      const res = await fetchFn(endpoints.revocation_endpoint, {
        ...form({ token: creds.refreshToken, token_type_hint: "refresh_token", client_id: creds.clientId }),
        signal: AbortSignal.timeout(15_000),
      });
      revoked = res.ok;
    }
  } catch {
    revoked = false;
  }
  await files.deleteCredentials();
  return { revoked, wasSignedIn: true };
}

/** What an access token says about itself (its claims, never the token): for `status`. */
export interface TokenClaims {
  aud: string[];
  scope: string[];
  azp: string | null;
  sub: string | null;
}

export function readTokenClaims(accessToken: string): TokenClaims | null {
  const part = accessToken.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
    const aud = Array.isArray(claims.aud) ? claims.aud.filter((a): a is string => typeof a === "string") : typeof claims.aud === "string" ? [claims.aud] : [];
    return {
      aud,
      scope: typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [],
      azp: typeof claims.azp === "string" ? claims.azp : null,
      sub: typeof claims.sub === "string" ? claims.sub : null,
    };
  } catch {
    return null;
  }
}

/**
 * Checks the claims the agent API needs. Returns problems in plain words (empty when fine).
 * The server decides for real; this only explains a refusal.
 */
export function tokenProblems(claims: TokenClaims, hostAudience = "ai-my-card-host-api", apiAudience = "ai-my-card-api"): string[] {
  const problems: string[] = [];
  if (!claims.aud.includes(hostAudience)) {
    problems.push(
      claims.scope.includes("host")
        ? `aud lacks "${hostAudience}" although "host" is in scope: the sign-in server doesn't add the host API audience for the "host" scope. Ask the server's admin.`
        : `aud lacks "${hostAudience}": the "host" scope isn't granted to the agent's sign-in client, or it doesn't add the host API audience. Ask the server's admin.`,
    );
  }
  if (claims.aud.includes(apiAudience)) {
    problems.push(`aud also contains "${apiAudience}", so the server refuses it (a token may not be valid for both): the agent's sign-in client also receives the inference API audience. Ask the server's admin.`);
  }
  if (!claims.scope.includes("host")) problems.push(`scope lacks "host": the sign-in server doesn't put the "host" scope into the token. Ask the server's admin.`);
  return problems;
}
