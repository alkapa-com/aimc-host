import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inHomeFolder, packagesToCopy, renderUnit } from "./service.ts";
import { compareVersions, updateCommand, versionAdvice } from "./version.ts";

describe("the systemd unit", () => {
  const unit = renderUnit({ nodePath: "/opt/aimc-host/bin/node", cliPath: "/opt/aimc-host/node_modules/aimc-host/dist/cli.js" });

  it("runs the copied agent with the copied node, as the service user", () => {
    expect(unit).toContain("ExecStart=/opt/aimc-host/bin/node /opt/aimc-host/node_modules/aimc-host/dist/cli.js start");
    expect(unit).toContain("User=ai-my-card-host");
    expect(unit).toContain("Environment=XDG_CONFIG_HOME=/var/lib/ai-my-card-host");
  });

  it("doesn't restart after a fatal exit (code 3) and keeps the hardening", () => {
    expect(unit).toContain("RestartPreventExitStatus=3");
    expect(unit).toContain("ProtectHome=yes");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("WantedBy=multi-user.target");
  });
});

describe("inHomeFolder", () => {
  it("spots Node from nvm and anything else the service can't see", () => {
    expect(inHomeFolder("/home/me/.nvm/versions/node/v22.13.0/bin/node", "/home/me")).toBe(true);
    expect(inHomeFolder("/root/.nvm/versions/node/v22.13.0/bin/node", "/root")).toBe(true);
    expect(inHomeFolder("/srv/users/me/node", "/srv/users/me")).toBe(true);
    expect(inHomeFolder("/usr/bin/node", "/home/me")).toBe(false);
    expect(inHomeFolder("/usr/local/bin/node", "/home/me")).toBe(false);
    expect(inHomeFolder("/homestead/node", "/home/me")).toBe(false);
  });
});

describe("packagesToCopy", () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function pkg(path: string, name: string, version: string, dependencies: Record<string, string> = {}) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "package.json"), JSON.stringify({ name, version, dependencies }));
  }

  it("finds the agent's dependencies nested (npm -g) or flat (npx), and theirs", async () => {
    dir = await mkdtemp(join(tmpdir(), "aimc-pkgs-"));
    // npx style: everything flat in one node_modules.
    const nm = join(dir, "node_modules");
    await pkg(join(nm, "aimc-host"), "aimc-host", "0.2.0", { "aimc-protocol": "1.0.0", zod: "4.6.7" });
    await pkg(join(nm, "aimc-protocol"), "aimc-protocol", "1.0.0", { zod: "4.6.7" });
    await pkg(join(nm, "zod"), "zod", "4.6.7");
    const flat = packagesToCopy(join(nm, "aimc-host"));
    expect([...flat.keys()].sort()).toEqual(["aimc-host", "aimc-protocol", "zod"]);

    // npm -g style: dependencies inside the package's own node_modules.
    const g = join(dir, "global", "aimc-host");
    await pkg(g, "aimc-host", "0.2.0", { "aimc-protocol": "1.0.0" });
    await pkg(join(g, "node_modules", "aimc-protocol"), "aimc-protocol", "1.0.0", { zod: "4.6.7" });
    await pkg(join(g, "node_modules", "zod"), "zod", "4.6.7");
    const nested = packagesToCopy(g);
    expect(nested.get("zod")).toContain(join("global", "aimc-host", "node_modules", "zod"));
  });

  it("says what's missing", async () => {
    dir = await mkdtemp(join(tmpdir(), "aimc-pkgs-"));
    await pkg(join(dir, "aimc-host"), "aimc-host", "0.2.0", { "aimc-protocol": "1.0.0" });
    expect(() => packagesToCopy(join(dir, "aimc-host"))).toThrow("Can't find aimc-protocol");
  });
});

describe("versions", () => {
  it("compares like semver", () => {
    expect(compareVersions("0.2.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("v2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("dev", "1.0.0")).toBeNull();
  });

  it("tells how to update, for the way the agent runs", () => {
    expect(updateCommand("0.3.0", {})).toBe("npm install -g aimc-host@0.3.0");
    expect(updateCommand("0.3.0", { npm_command: "exec" })).toBe("npx aimc-host@0.3.0 start");
    expect(updateCommand("0.3.0", { INVOCATION_ID: "x" })).toContain("aimc-host install-service");
  });

  it("advises an update, or refuses to run below the server's minimum", () => {
    expect(versionAdvice("0.2.0", {})).toBeNull();
    expect(versionAdvice("0.2.0", { latestAgentVersion: "0.2.0" })).toBeNull();
    expect(versionAdvice("0.2.0", { latestAgentVersion: "0.3.0" })).toMatchObject({ kind: "update" });
    expect(versionAdvice("0.2.0", { latestAgentVersion: "0.3.0", minAgentVersion: "0.2.1" })).toMatchObject({ kind: "too_old" });
    // Nonsense from the server is ignored, not fatal.
    expect(versionAdvice("0.2.0", { latestAgentVersion: "latest", minAgentVersion: "?" })).toBeNull();
  });
});
