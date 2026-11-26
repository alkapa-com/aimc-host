#!/usr/bin/env node
// Publishes every package whose version isn't on npm yet: the protocol first, then the host.
// Runs in the release workflow (GitHub Actions, with npm provenance). Locally, --dry-run shows
// what it would publish.
//
//   node scripts/publish.mjs [--dry-run]

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dryRun = process.argv.includes("--dry-run");
const win = process.platform === "win32";
const npm = (args) => execFileSync(win ? "npm.cmd" : "npm", args, { cwd: root, encoding: "utf8", shell: win, stdio: ["ignore", "pipe", "pipe"] });

for (const dir of ["packages/protocol", "packages/host"]) {
  const { name, version } = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), "utf8"));
  let published = false;
  try {
    published = npm(["view", `${name}@${version}`, "version"]).trim() === version;
  } catch {
    published = false; // E404: the package or this version doesn't exist yet
  }
  if (published) {
    console.log(`${name}@${version} is already on npm: skipped.`);
    continue;
  }
  const tag = version.includes("-") ? "next" : "latest";
  console.log(`${dryRun ? "Would publish" : "Publishing"} ${name}@${version} (tag ${tag})...`);
  if (dryRun) continue;
  execFileSync(win ? "npm.cmd" : "npm", ["publish", "-w", name, "--access", "public", "--provenance", "--tag", tag], {
    cwd: root,
    stdio: "inherit",
    shell: win,
  });
}
