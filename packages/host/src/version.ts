import { readFileSync } from "node:fs";

// This agent's version (from its package.json) and the update notice the server can trigger.

export const PACKAGE_NAME = "aimc-host";

export const AGENT_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

/**
 * Compares two versions like 0.2.0 or 1.4.0-beta.1: negative when a < b, 0 when equal, positive
 * when a > b. Pre-releases sort before their release. Null when either isn't a version.
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d;
  }
  const [px, py] = [x[4], y[4]];
  if (px === py) return 0;
  if (px === undefined) return 1;
  if (py === undefined) return -1;
  const ax = px.split(".");
  const ay = py.split(".");
  for (let i = 0; i < Math.max(ax.length, ay.length); i++) {
    const [p, q] = [ax[i], ay[i]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const [np, nq] = [Number(p), Number(q)];
    if (Number.isInteger(np) && Number.isInteger(nq)) return np - nq;
    if (Number.isInteger(np)) return -1;
    if (Number.isInteger(nq)) return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Running under systemd (it sets INVOCATION_ID for every service it starts). */
export function runsAsService(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.INVOCATION_ID);
}

/** How to update to `version`, for the way this agent runs. */
export function updateCommand(version: string, env: NodeJS.ProcessEnv = process.env): string {
  if (runsAsService(env)) return `npm install -g ${PACKAGE_NAME}@${version}, then: ${PACKAGE_NAME} install-service`;
  if (env.npm_command === "exec") return `npx ${PACKAGE_NAME}@${version} start`;
  return `npm install -g ${PACKAGE_NAME}@${version}`;
}

/** What the server's hello says about this agent's version. */
export function versionAdvice(
  current: string,
  hello: { latestAgentVersion?: string | undefined; minAgentVersion?: string | undefined },
): { kind: "too_old"; message: string } | { kind: "update"; message: string } | null {
  const min = hello.minAgentVersion;
  if (min && (compareVersions(current, min) ?? 0) < 0) {
    return { kind: "too_old", message: `This server needs host agent ${min} or newer; this is ${current}. Update: ${updateCommand(hello.latestAgentVersion ?? min)}` };
  }
  const latest = hello.latestAgentVersion;
  if (latest && (compareVersions(current, latest) ?? 0) < 0) {
    return { kind: "update", message: `A newer host agent is available: ${latest} (this is ${current}). Update: ${updateCommand(latest)}` };
  }
  return null;
}
