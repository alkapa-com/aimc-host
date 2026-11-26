#!/usr/bin/env node
// Packs both packages the way npm publishes them, installs the tarballs into a throwaway global
// folder and runs the installed CLI: proves the published packages work from node_modules.
//
//   node scripts/smoke.mjs            (after `npm run build`)

import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const win = process.platform === "win32";
const npm = (args, cwd = root) =>
  execFileSync(win ? "npm.cmd" : "npm", args, { cwd, encoding: "utf8", shell: win, stdio: ["ignore", "pipe", "inherit"] });

const work = await mkdtemp(join(tmpdir(), "aimc-smoke-"));
try {
  npm(["pack", "-w", "aimc-protocol", "-w", "aimc-host", "--pack-destination", work, "--silent"]);
  const tarballs = (await readdir(work)).filter((f) => f.endsWith(".tgz")).map((f) => join(work, f));
  if (tarballs.length !== 2) throw new Error(`expected 2 tarballs, got ${tarballs.join(", ")}`);
  const prefix = join(work, "global");
  npm(["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", "--silent", ...tarballs], work);
  const bin = win ? join(prefix, "aimc-host.cmd") : join(prefix, "bin", "aimc-host");
  const out = execFileSync(bin, ["version"], { encoding: "utf8", shell: win, env: { ...process.env, AIMC_RUN: "" } });
  if (!/^aimc-host \d+\.\d+\.\d+/.test(out)) throw new Error(`unexpected output: ${out}`);
  const help = execFileSync(bin, ["help"], { encoding: "utf8", shell: win });
  if (!help.includes("install-service")) throw new Error("help is missing install-service");
  console.log(`smoke ok: ${out.trim()}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
