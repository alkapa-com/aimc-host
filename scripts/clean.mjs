#!/usr/bin/env node
// Deletes the given folders (relative to the current folder): `node clean.mjs dist`.
// A script instead of `rm -rf`, so the build works the same in PowerShell, cmd and sh.

import { rm } from "node:fs/promises";

for (const dir of process.argv.slice(2)) await rm(dir, { recursive: true, force: true });
