import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run on the TypeScript sources: the host's imports of aimc-protocol/* go to the
// protocol's src/, so nothing needs building first.
const protocolSrc = fileURLToPath(new URL("./packages/protocol/src/", import.meta.url));

export default defineConfig({
  resolve: { alias: [{ find: /^aimc-protocol\/(agent|sse)$/, replacement: `${protocolSrc}$1.ts` }] },
  test: { environment: "node", include: ["packages/*/src/**/*.test.ts"] },
});
