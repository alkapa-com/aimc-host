#!/usr/bin/env node
// Runs the host agent from this repository's TypeScript source, with exactly the arguments
// you give it (no build step):
//
//   node scripts/dev.mjs status
//   node scripts/dev.mjs login --server https://your-server.example
//
// Why not `npm run agent -- ...`? PowerShell removes the `--`, and npm then takes options like
// --server as its own. Plain `node` passes everything through, in every shell.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../packages/host/src/cli.ts", import.meta.url));

process.env.AIMC_RUN ??= "node scripts/dev.mjs";
// Ctrl+C reaches both processes; the agent stops cleanly, this launcher just waits for it.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

const result = spawnSync(
  process.execPath,
  ["--conditions=aimc-source", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
if (result.error) {
  console.error(`Could not start the agent: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
