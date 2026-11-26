import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// A stable id for this machine, so the server can say "this machine is already your host X"
// instead of quietly adding a second host. Only a hash leaves the machine, never the id itself.
// The OS id: Windows MachineGuid, Linux /etc/machine-id, macOS IOPlatformUUID.

function rawMachineId(platform: NodeJS.Platform): string | null {
  const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
  try {
    if (platform === "win32") {
      const out = run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
      return /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out)?.[1] ?? null;
    }
    if (platform === "darwin") return /"IOPlatformUUID" = "([^"]+)"/.exec(run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]))?.[1] ?? null;
    for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const id = readFileSync(file, "utf8").trim();
        if (id) return id;
      } catch {
        // try the next one
      }
    }
  } catch {
    // no id: the server just can't spot duplicates
  }
  return null;
}

/** 64 hex characters, or undefined when the OS has no machine id. */
export function hashMachineId(raw: string): string {
  return createHash("sha256").update(`aimc-host machine\n${raw.trim().toLowerCase()}`).digest("hex");
}

export function machineId(platform: NodeJS.Platform = process.platform): string | undefined {
  const raw = rawMachineId(platform);
  return raw ? hashMachineId(raw) : undefined;
}
