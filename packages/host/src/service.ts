import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, chown, copyFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentFiles, configDir } from "./config.ts";
import { PACKAGE_NAME } from "./version.ts";

// The agent as a systemd service (Linux): `install-service`, `uninstall-service` and `service`.
//
// The service runs as its own unprivileged user with ProtectHome=yes, so neither Node nor the
// agent may live in a home folder. A Node from nvm and a global npm install under nvm both do.
// So install-service copies the agent (and its two dependencies) to /opt/aimc-host, and Node too
// when it lives in a home folder. Re-run it after every update: it replaces the copy and
// restarts the service.
//
// Settings and the sign-in of the service live in /var/lib/ai-my-card-host/ai-my-card-host
// (XDG_CONFIG_HOME=/var/lib/ai-my-card-host), readable only by the service user.

export const SERVICE_NAME = "ai-my-card-host-agent";
export const SERVICE_USER = "ai-my-card-host";
export const STATE_DIR = "/var/lib/ai-my-card-host";
export const INSTALL_DIR = "/opt/aimc-host";
export const UNIT_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;
/** Written by install-service: which Node and which agent the service runs. */
const INSTALL_INFO = join(INSTALL_DIR, "install.json");

export interface ServiceOptions {
  dryRun: boolean;
  copySettings: boolean;
  noStart: boolean;
  purge: boolean;
  /** Internal: the invoking user's settings folder, passed through sudo. */
  settingsFrom: string | undefined;
}

export interface UnitInputs {
  nodePath: string;
  cliPath: string;
}

/** The systemd unit. Exit code 3 means retrying is pointless (host retired, signed out...). */
export function renderUnit({ nodePath, cliPath }: UnitInputs): string {
  return `# aimc-host: lends this GPU to an aimc server. Written by \`${PACKAGE_NAME} install-service\`;
# run it again after an update instead of editing this file.
#
# Runs as its own unprivileged user. Its settings and sign-in live in
# ${STATE_DIR}/ai-my-card-host (XDG_CONFIG_HOME below), readable only by that user.

[Unit]
Description=aimc host agent (lends this GPU to an aimc server)
Documentation=https://www.npmjs.com/package/${PACKAGE_NAME}
After=network-online.target ollama.service
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
Environment=XDG_CONFIG_HOME=${STATE_DIR}
ExecStart=${nodePath} ${cliPath} start
Restart=on-failure
RestartSec=30
RestartPreventExitStatus=3
KillSignal=SIGTERM
TimeoutStopSec=20

# Hardening: it only needs the network, Ollama, nvidia-smi and its own folder.
StateDirectory=ai-my-card-host
StateDirectoryMode=0700
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
# Not PrivateDevices: nvidia-smi needs /dev/nvidia* for the GPU telemetry.

[Install]
WantedBy=multi-user.target
`;
}

/** True for paths the service can't see (ProtectHome=yes): /home, /root, /run/user. */
export function inHomeFolder(path: string, home: string = homedir()): boolean {
  const p = path.replace(/\/+$/, "");
  return ["/home", "/root", "/run/user", home].some((h) => h && h !== "/" && (p === h || p.startsWith(`${h}/`)));
}

/** Where this running agent's package is (the folder with its package.json). */
export function ownPackageDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

const readPackage = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson;

/** Node's lookup: <dir>/node_modules/<name>, then the same in each parent folder. */
function findDependency(fromDir: string, name: string): string {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`Can't find ${name} (needed by the agent). Reinstall: npm install -g ${PACKAGE_NAME}`);
  }
}

/** The agent's package and every package it needs, by name: what goes to /opt/aimc-host/node_modules. */
export function packagesToCopy(rootDir: string = ownPackageDir()): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (name: string, dir: string) => {
    const pkg = readPackage(dir);
    const seen = found.get(name);
    if (seen) {
      if (readPackage(seen).version !== pkg.version) throw new Error(`Two versions of ${name} are installed; reinstall the agent.`);
      return;
    }
    found.set(name, dir);
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, findDependency(dir, dep));
  };
  visit(readPackage(rootDir).name, realpathSync(rootDir));
  return found;
}

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
const tryRun = (cmd: string, args: string[]): string | null => {
  try {
    return run(cmd, args);
  } catch {
    return null;
  }
};

function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function requireLinux(command: string) {
  if (process.platform !== "linux") {
    throw new Error(
      `${command} is for Linux with systemd. On Windows, keep \`${PACKAGE_NAME} start\` running in a terminal, or start it at login with a shortcut in your Startup folder.`,
    );
  }
  if (!existsSync("/run/systemd/system")) throw new Error(`${command} needs systemd, which isn't running on this machine.`);
}

/** Runs this same command again as root, through sudo (asks for your password). */
function elevate(args: string[]): number {
  const cli = realpathSync(process.argv[1] ?? "");
  console.log(`This needs root: running it with sudo.`);
  const result = spawnSync("sudo", [process.execPath, ...process.execArgv, cli, ...args], { stdio: "inherit" });
  if (result.error) throw new Error(`Couldn't run sudo: ${result.error.message}`);
  return result.status ?? 1;
}

function serviceIds(): { uid: number; gid: number } | null {
  const uid = tryRun("id", ["-u", SERVICE_USER]);
  const gid = tryRun("id", ["-g", SERVICE_USER]);
  return uid && gid ? { uid: Number(uid), gid: Number(gid) } : null;
}

/** The service's settings: are sign-in, host and models there, so it can start? */
async function serviceReady(): Promise<{ ready: boolean; missing: string[] }> {
  const files = new AgentFiles(join(STATE_DIR, "ai-my-card-host"), "linux");
  const missing: string[] = [];
  try {
    const config = await files.loadConfig();
    if (!config.serverUrl || !(await files.loadCredentials())) missing.push("login");
    if (!config.hostId) missing.push("register");
    if (config.models.length === 0) missing.push("config --models");
  } catch {
    missing.push("login");
  }
  return { ready: missing.length === 0, missing };
}

export async function installService(o: ServiceOptions): Promise<number> {
  const packages = packagesToCopy();
  const execNode = realpathSync(process.execPath);
  const copyNode = inHomeFolder(execNode, process.env.SUDO_USER ? `/home/${process.env.SUDO_USER}` : homedir());
  const nodePath = copyNode ? join(INSTALL_DIR, "bin", "node") : execNode;
  const cliPath = join(INSTALL_DIR, "node_modules", PACKAGE_NAME, "dist", "cli.js");
  const version = readPackage(packages.get(PACKAGE_NAME) ?? ownPackageDir()).version;

  if (o.dryRun) {
    console.log(`install-service would, as root:
  1. create the system user ${SERVICE_USER} (if missing) and ${STATE_DIR} (mode 700)
  2. copy ${PACKAGE_NAME} ${version} and its packages to ${INSTALL_DIR}/node_modules:
${[...packages].map(([name, dir]) => `       ${name}  from ${dir}`).join("\n")}
  3. ${copyNode ? `copy Node ${process.version} from ${execNode} to ${nodePath} (it lives in a home folder, which the service can't see)` : `use Node ${process.version} at ${nodePath}`}
  4. ${o.copySettings ? `copy your settings and sign-in from ${configDir()} to ${STATE_DIR}/ai-my-card-host (if the service has none yet)` : "keep the service's own settings (add --copy-settings to bring yours)"}
  5. write ${UNIT_PATH}, enable it${o.noStart ? "" : " and (re)start it once signed in, registered and configured"}

The unit:
`);
    console.log(renderUnit({ nodePath, cliPath }));
    return 0;
  }

  requireLinux("install-service");
  if (!isRoot()) {
    const args = ["install-service"];
    if (o.copySettings) args.push("--copy-settings", "--settings-from", configDir());
    if (o.noStart) args.push("--no-start");
    return elevate(args);
  }

  // 1. The service user and its private folder.
  if (!serviceIds()) {
    run("useradd", ["--system", "--home-dir", STATE_DIR, "--shell", "/usr/sbin/nologin", SERVICE_USER]);
    console.log(`Created the system user ${SERVICE_USER}.`);
  }
  const ids = serviceIds();
  if (!ids) throw new Error(`Couldn't create the user ${SERVICE_USER}.`);
  const settingsDir = join(STATE_DIR, "ai-my-card-host");
  for (const dir of [STATE_DIR, settingsDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chown(dir, ids.uid, ids.gid);
    await chmod(dir, 0o700);
  }

  // 2 + 3. A fresh copy of the agent (and Node), swapped in at once.
  const staging = `${INSTALL_DIR}.new`;
  await rm(staging, { recursive: true, force: true });
  for (const [name, dir] of packages) {
    const target = join(staging, "node_modules", ...name.split("/"));
    await cp(dir, target, {
      recursive: true,
      dereference: true,
      // Not the package's own node_modules: its dependencies are copied next to it.
      filter: (src) => !relative(dir, src).split(sep).includes("node_modules"),
    });
  }
  if (copyNode) {
    await mkdir(join(staging, "bin"), { recursive: true, mode: 0o755 });
    await copyFile(execNode, join(staging, "bin", "node"));
    await chmod(join(staging, "bin", "node"), 0o755);
  }
  await writeFile(join(staging, "install.json"), `${JSON.stringify({ version, nodePath, cliPath, installedAt: new Date().toISOString() }, null, 2)}\n`);
  await chmod(staging, 0o755);
  const old = `${INSTALL_DIR}.old`;
  await rm(old, { recursive: true, force: true });
  if (existsSync(INSTALL_DIR)) await rename(INSTALL_DIR, old);
  await rename(staging, INSTALL_DIR);
  await rm(old, { recursive: true, force: true });
  console.log(`Installed ${PACKAGE_NAME} ${version} in ${INSTALL_DIR}${copyNode ? `, with Node ${process.version}` : ""}.`);

  // 4. Your settings, if asked and the service has none yet.
  if (o.copySettings && o.settingsFrom) {
    for (const file of ["config.json", "credentials.json"]) {
      const from = join(o.settingsFrom, file);
      const to = join(settingsDir, file);
      if (!existsSync(from)) continue;
      if (existsSync(to)) {
        console.log(`Kept the service's own ${file} (delete ${to} first to replace it).`);
        continue;
      }
      await copyFile(from, to);
      await chown(to, ids.uid, ids.gid);
      await chmod(to, 0o600);
      console.log(`Copied your ${file} to the service.`);
    }
  }

  // 5. The unit.
  await writeFile(UNIT_PATH, renderUnit({ nodePath, cliPath }), { mode: 0o644 });
  run("systemctl", ["daemon-reload"]);
  run("systemctl", ["enable", SERVICE_NAME]);
  console.log(`Wrote ${UNIT_PATH} and enabled it (it starts at boot).`);

  const { ready, missing } = await serviceReady();
  if (!ready) {
    console.log(`\nThe service isn't set up yet. Do these once, as the service:`);
    for (const step of missing) {
      const example = step === "login" ? "login --server https://your-server.example" : step === "register" ? "register --name <a name for this machine>" : "config --models <models, comma-separated>";
      console.log(`  ${PACKAGE_NAME} service ${example}`);
    }
    console.log(`Then: sudo systemctl start ${SERVICE_NAME}`);
    if (!o.copySettings && existsSync(join(configDir(), "credentials.json"))) {
      console.log(`(Or bring the settings you already have: ${PACKAGE_NAME} install-service --copy-settings)`);
    }
    return 0;
  }
  if (o.noStart) {
    console.log(`Start it with: sudo systemctl start ${SERVICE_NAME}`);
    return 0;
  }
  run("systemctl", ["restart", SERVICE_NAME]);
  console.log(`Started. Its log: journalctl -u ${SERVICE_NAME} -f`);
  console.log(`Don't also run \`${PACKAGE_NAME} start\` for the same host elsewhere: one connection per host.`);
  return 0;
}

export async function uninstallService(o: ServiceOptions): Promise<number> {
  if (o.dryRun) {
    console.log(`uninstall-service would stop and disable ${SERVICE_NAME}, delete ${UNIT_PATH} and ${INSTALL_DIR}${o.purge ? `, and delete the service's settings and sign-in (${STATE_DIR}) and the user ${SERVICE_USER}` : `. The service's settings and sign-in in ${STATE_DIR} stay (--purge deletes them).`}`);
    return 0;
  }
  requireLinux("uninstall-service");
  if (!isRoot()) return elevate(["uninstall-service", ...(o.purge ? ["--purge"] : [])]);
  tryRun("systemctl", ["disable", "--now", SERVICE_NAME]);
  await rm(UNIT_PATH, { force: true });
  tryRun("systemctl", ["daemon-reload"]);
  await rm(INSTALL_DIR, { recursive: true, force: true });
  console.log(`Removed the service ${SERVICE_NAME} and ${INSTALL_DIR}.`);
  if (o.purge) {
    await rm(STATE_DIR, { recursive: true, force: true });
    tryRun("userdel", [SERVICE_USER]);
    console.log(`Deleted the service's settings and sign-in, and the user ${SERVICE_USER}. The host stays registered on the server until you retire it there.`);
  } else {
    console.log(`The service's settings and sign-in stay in ${STATE_DIR} (uninstall-service --purge deletes them).`);
  }
  return 0;
}

/**
 * `service <command>`: runs an agent command as the service user, with the service's settings
 * (e.g. `service login --server ...`, `service status`). Uses the copy in /opt/aimc-host.
 */
export async function runAsService(args: string[]): Promise<number> {
  requireLinux("service");
  if (args[0] === "start") {
    throw new Error(`The service runs the agent itself: sudo systemctl start ${SERVICE_NAME} (log: journalctl -u ${SERVICE_NAME} -f).`);
  }
  if (!isRoot()) return elevate(["service", ...args]);
  let info: { nodePath: string; cliPath: string };
  try {
    info = JSON.parse(await readFile(INSTALL_INFO, "utf8")) as { nodePath: string; cliPath: string };
  } catch {
    throw new Error(`The service isn't installed. Run: ${PACKAGE_NAME} install-service`);
  }
  const ids = serviceIds();
  if (!ids) throw new Error(`The user ${SERVICE_USER} doesn't exist. Run: ${PACKAGE_NAME} install-service`);
  const result = spawnSync(info.nodePath, [info.cliPath, ...args], {
    stdio: "inherit",
    cwd: INSTALL_DIR,
    uid: ids.uid,
    gid: ids.gid,
    env: {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: STATE_DIR,
      XDG_CONFIG_HOME: STATE_DIR,
      AIMC_RUN: `${PACKAGE_NAME} service`,
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      ...(process.env.TERM ? { TERM: process.env.TERM } : {}),
    },
  });
  if (result.error) throw new Error(`Couldn't run the agent as ${SERVICE_USER}: ${result.error.message}`);
  return result.status ?? 1;
}
