#!/usr/bin/env node
import { PROTOCOL_VERSION } from "aimc-protocol/agent";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { parseArgs } from "node:util";
import { deviceLogin, fetchServerConfig, logout, NotSignedInError, readTokenClaims, tokenProblems, TokenSource } from "./auth.ts";
import { AgentFiles, agentConfig, checkOllamaUrl, checkServerUrl, type AgentConfig } from "./config.ts";
import { AlreadyRunningError, describeRun, describeState, liveRun, readRun, RunFile, stopRun, type RunInfo } from "./instance.ts";
import { machineId } from "./machine.ts";
import { OllamaClient } from "./ollama.ts";
import { FatalError, Runner } from "./runner.ts";
import { ServerClient, ServerError } from "./server-client.ts";
import {
  controlLinuxService,
  installService,
  linuxServiceInstalled,
  linuxServiceState,
  runAsService,
  SERVICE_NAME,
  SERVICE_RUN_DIR,
  uninstallService,
} from "./service.ts";
import { readGpu } from "./telemetry.ts";
import { AGENT_VERSION, PACKAGE_NAME, runsAsService } from "./version.ts";

// aimc-host: lend your GPU to an aimc server. Run: aimc-host <command> (or npx aimc-host ...).

/** How you started the agent, for the hints below ("Next: aimc-host register ..."). */
const RUN = process.env.AIMC_RUN || (process.env.npm_command === "exec" ? `npx ${PACKAGE_NAME}` : PACKAGE_NAME);

const HELP = `aimc-host ${AGENT_VERSION}: lend your GPU to an aimc server

Usage: ${RUN} <command> [options]

  login [--server] URL      sign in (shows a code you confirm in any browser)
  config [options]          show or change settings:
      --server URL            the server, e.g. https://your-server.example
      --ollama URL            your Ollama (default http://127.0.0.1:11434)
      --models a,b            the local models you offer (only these are ever run)
      --max-concurrent N      jobs at once on this machine (default 1)
      --host-id ID            use a host you registered before (from this machine)
  register --name NAME      add this machine as a host (an admin approves it)
      --force                 a new host even if this machine already is one of yours
  start                     run: take jobs until Ctrl+C (starts the service, if installed)
      --foreground            run in this terminal even if the service is installed
  stop                      stop the agent (the service, or the one in a terminal)
  status                    is it running, and settings, sign-in, Ollama and server
  logout                    sign out and revoke the sign-in
  version                   show this agent's version

One copy of the agent runs per host: a second \`start\` is refused.

Linux (systemd), asks for sudo:
  install-service           run the agent as a service, started at boot
      --copy-settings         bring your sign-in and settings to the service
      --no-start              install and enable, but don't (re)start it
      --dry-run               only show what it would do
  service <command>         run a command as the service, e.g. service status
  uninstall-service         remove the service (--purge: its sign-in and settings too)

Settings and the sign-in live in ${new AgentFiles().dir}
The sign-in file (credentials.json) is a secret: anyone with it can act as this host.`;

const log = (message: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);

/** Where the running agent keeps run.json: the service's /run folder, else the settings folder. */
function runDir(files: AgentFiles, asService: boolean): string {
  if (asService && process.platform === "linux") {
    try {
      accessSync(SERVICE_RUN_DIR, constants.W_OK); // a unit from 0.2 has no such folder
      return SERVICE_RUN_DIR;
    } catch {
      // fall back to the settings folder
    }
  }
  return files.dir;
}

/** The installed Linux service's run, if it runs: from its run.json, or just systemd's word. */
async function serviceRun(): Promise<{ state: string | null; run: RunInfo | null }> {
  if (!linuxServiceInstalled()) return { state: null, run: null };
  const state = linuxServiceState();
  return { state, run: state === "active" ? await liveRun(SERVICE_RUN_DIR) : null };
}

/** Waits a few seconds for the service's run.json, to say how it is doing. */
async function reportServiceStart(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const run = await readRun(SERVICE_RUN_DIR);
    if (run && run.state !== "starting") {
      console.log(`Running ${describeRun(run)}: ${describeState(run)}.`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`Started the service. Check it: ${RUN} status (its log: journalctl -u ${SERVICE_NAME} -f)`);
}

function requireServer(config: AgentConfig): string {
  if (!config.serverUrl) throw new Error(`No server set. Run: ${RUN} login --server https://your-server.example`);
  return config.serverUrl;
}

/** `start`, once this run holds the run folder: the agent until Ctrl+C, `stop` or a fatal error. */
async function runAgent(server: string, config: AgentConfig, hostId: string, files: AgentFiles, run: RunFile, runId: string): Promise<number> {
  const ollama = new OllamaClient(fetch, config.ollamaUrl);
  const installed = await ollama.installed().catch((err: Error) => {
    throw new Error(`${err.message} Is Ollama running?`);
  });
  const missing = config.models.filter((m) => !installed.includes(m));
  if (missing.length) log(`Warning: offered but not installed in Ollama: ${missing.join(", ")}. Jobs for them will fail.`);

  const stop = new AbortController();
  const onStop = (why: string) => {
    if (stop.signal.aborted) return;
    log(`Stopping (${why})...`);
    run.update("stopping");
    stop.abort();
  };
  process.once("SIGINT", () => onStop("Ctrl+C"));
  process.once("SIGTERM", () => onStop("asked to stop"));
  run.watchStop(() => onStop(`${RUN} stop`));
  log(`Starting host ${hostId} against ${server}.`);
  await new Runner({
    server: new ServerClient(fetch, server, new TokenSource(fetch, files), runId),
    ollama,
    hostId,
    models: config.models,
    maxConcurrent: config.maxConcurrent,
    agentVersion: AGENT_VERSION,
    readGpu,
    log,
    signal: stop.signal,
    machineId: machineId(),
    onState: (state, detail) => run.update(state, detail),
    onJobDone: () => run.jobDone(),
  }).run();
  log("Stopped.");
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  // Everything after `service` belongs to the command run as the service.
  if (command === "service") {
    if (rest.length === 0) throw new Error(`Which command? E.g. ${RUN} service status`);
    return runAsService(rest);
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      server: { type: "string" },
      ollama: { type: "string" },
      models: { type: "string" },
      "max-concurrent": { type: "string" },
      name: { type: "string" },
      "host-id": { type: "string" },
      force: { type: "boolean" },
      foreground: { type: "boolean" },
      service: { type: "boolean" },
      "copy-settings": { type: "boolean" },
      "no-start": { type: "boolean" },
      "dry-run": { type: "boolean" },
      purge: { type: "boolean" },
      "settings-from": { type: "string" },
    },
    strict: true,
  });
  const serviceOptions = {
    dryRun: values["dry-run"] ?? false,
    copySettings: values["copy-settings"] ?? false,
    noStart: values["no-start"] ?? false,
    purge: values.purge ?? false,
    settingsFrom: values["settings-from"],
  };
  // Only login takes a plain argument (the server). Anything else stray is a typo.
  if (positionals.length > (command === "login" ? 1 : 0)) {
    throw new Error(`Unexpected argument '${positionals.at(-1)}'. Options start with --, e.g. --models a,b. See: ${RUN} help`);
  }
  const files = new AgentFiles();
  const config = await files.loadConfig();

  switch (command) {
    case "login": {
      const serverArg = values.server ?? positionals[0];
      if (serverArg) config.serverUrl = checkServerUrl(serverArg);
      const server = requireServer(config);
      await files.saveConfig(config);
      const creds = await deviceLogin({
        fetchFn: fetch,
        serverUrl: server,
        show: (p) => {
          console.log("\nTo sign in, open this link on any device and confirm the code:\n");
          console.log(`  ${p.verificationUriComplete ?? p.verificationUri}`);
          console.log(`  code: ${p.userCode}\n`);
          console.log(`Waiting for you to confirm (the code is valid for ${Math.round(p.expiresInSec / 60)} minutes)...`);
        },
      });
      await files.saveCredentials(creds);
      console.log(`Signed in. The sign-in is stored in ${files.credentialsPath()} (keep it secret).`);
      if (!config.hostId) console.log(`Next: ${RUN} register --name <a name for this machine>`);
      return 0;
    }

    case "config": {
      let changed = false;
      if (values.server) {
        config.serverUrl = checkServerUrl(values.server);
        changed = true;
      }
      if (values.ollama) {
        config.ollamaUrl = checkOllamaUrl(values.ollama);
        changed = true;
      }
      if (values.models !== undefined) {
        config.models = [...new Set(values.models.split(",").map((m) => m.trim()).filter(Boolean))];
        changed = true;
      }
      if (values["max-concurrent"] !== undefined) {
        const n = Number(values["max-concurrent"]);
        if (!Number.isInteger(n) || n < 1 || n > 32) throw new Error("--max-concurrent must be a whole number from 1 to 32.");
        config.maxConcurrent = n;
        changed = true;
      }
      if (values["host-id"] !== undefined) {
        config.hostId = values["host-id"].trim().toLowerCase();
        changed = true;
      }
      if (changed) {
        const parsed = agentConfig.safeParse(config);
        if (!parsed.success) {
          throw new Error(parsed.error.issues.some((i) => i.path[0] === "hostId") ? "--host-id must be a host id like 123e4567-e89b-42d3-a456-426614174000." : "Model names look like gemma3:12b (letters, digits, . _ : / -).");
        }
        await files.saveConfig(parsed.data);
        const running = await liveRun(files.dir);
        console.log(running ? `Saved. The agent is running (${describeRun(running)}): ${RUN} stop, then ${RUN} start, to apply.` : "Saved.");
      }
      console.log(JSON.stringify(config, null, 2));
      if (values.models !== undefined) {
        const installed = await new OllamaClient(fetch, config.ollamaUrl).installed().catch(() => null);
        const missing = installed ? config.models.filter((m) => !installed.includes(m)) : [];
        if (missing.length) console.log(`Warning: not installed in Ollama: ${missing.join(", ")} (ollama pull <model>).`);
      }
      return 0;
    }

    case "register": {
      const server = requireServer(config);
      if (!values.name) throw new Error("Give the host a name: register --name my-desktop");
      if (config.hostId && !values.force) {
        throw new Error(`This machine is already registered as host ${config.hostId}. Use --force to register a new host instead.`);
      }
      const client = new ServerClient(fetch, server, new TokenSource(fetch, files));
      const result = await client.register(values.name, machineId(), values.force);
      config.hostId = result.hostId;
      await files.saveConfig(config);
      console.log(`Registered as host ${result.hostId}, waiting for an admin's approval.`);
      if (config.models.length === 0) console.log(`Next: ${RUN} config --models <the models you offer>, then start.`);
      else console.log(`Next: ${RUN} start (it waits until the host is approved).`);
      return 0;
    }

    case "start": {
      const asService = Boolean(values.service) || runsAsService();
      if (asService) process.env.AIMC_SERVICE = "1";
      const service = await serviceRun();

      // The service is installed: `start` starts it (unless asked to run here).
      if (service.state && !asService && !values.foreground) {
        if (service.state === "active") {
          console.log(service.run ? `Already running ${describeRun(service.run)}: ${describeState(service.run)}.` : "The service is already running.");
          return 0;
        }
        controlLinuxService("start");
        await reportServiceStart();
        return 0;
      }
      // One copy per host: not next to the running service.
      if (!asService && service.state === "active" && (!service.run || service.run.hostId === config.hostId)) {
        throw new Error(`The service is already running this host${service.run ? ` (${describeRun(service.run)})` : ""}. Stop it first: ${RUN} stop`);
      }

      const server = requireServer(config);
      if (!config.hostId) throw new Error(`Not registered yet. Run: ${RUN} register --name <name>`);
      if (config.models.length === 0) throw new Error(`No models offered. Run: ${RUN} config --models gemma3:12b`);
      const runId = randomUUID();
      let run: RunFile;
      try {
        run = await RunFile.acquire(runDir(files, asService), {
          pid: process.pid,
          runId,
          mode: asService ? "service" : "terminal",
          hostId: config.hostId,
          version: AGENT_VERSION,
        });
      } catch (err) {
        if (err instanceof AlreadyRunningError) throw new Error(`The agent is already running (${describeRun(err.info)}): ${describeState(err.info)}. Stop it first: ${RUN} stop`);
        throw err;
      }
      try {
        return await runAgent(server, config, config.hostId, files, run, runId);
      } finally {
        await run.release();
      }
    }

    case "stop": {
      const service = await serviceRun();
      if (service.state === "active" || service.state === "activating" || service.state === "reloading") {
        controlLinuxService("stop");
        console.log("Stopped the service. It starts again at boot; start it now with: " + `${RUN} start`);
        return 0;
      }
      if (await stopRun(files.dir)) return 0;
      console.log(service.state ? `Not running (the service is ${service.state}).` : "Not running.");
      return 0;
    }

    case "status": {
      const local = await liveRun(files.dir);
      const service = await serviceRun();
      if (local) {
        console.log(`Running:   yes, ${describeRun(local)}`);
        console.log(`State:     ${describeState(local)}`);
      }
      if (service.state === "active") {
        if (service.run) {
          console.log(`Running:   yes, ${describeRun(service.run)}`);
          console.log(`State:     ${describeState(service.run)}`);
        } else console.log("Running:   yes, as the service (no details: reinstall it with install-service to see them)");
      }
      if (!local && service.state !== "active") console.log(`Running:   no (start it: ${RUN} start)`);
      if (service.state) console.log(`Service:   installed, ${service.state}; it has its own settings (${RUN} service status)`);
      console.log(`Agent:     ${PACKAGE_NAME} ${AGENT_VERSION}`);
      console.log(`Settings:  ${files.dir}`);
      console.log(`Server:    ${config.serverUrl ?? "not set"}`);
      console.log(`Host id:   ${config.hostId ?? "not registered"}`);
      console.log(`Offering:  ${config.models.join(", ") || "nothing"} (up to ${config.maxConcurrent} at once)`);
      const ollama = new OllamaClient(fetch, config.ollamaUrl);
      try {
        const [version, installed] = await Promise.all([ollama.version(), ollama.installed()]);
        const missing = config.models.filter((m) => !installed.includes(m));
        console.log(`Ollama:    ${config.ollamaUrl}, version ${version}${missing.length ? `; NOT installed: ${missing.join(", ")}` : ""}`);
      } catch (err) {
        console.log(`Ollama:    ${(err as Error).message}`);
      }
      const gpu = await readGpu();
      console.log(`GPU:       ${gpu ? `${gpu.name}, ${(gpu.vramTotalMb / 1024).toFixed(1)} GB` : "no NVIDIA GPU found (nvidia-smi)"}`);
      if (config.serverUrl) {
        try {
          await fetchServerConfig(fetch, config.serverUrl);
          console.log("Server:    reachable");
        } catch (err) {
          console.log(`Server:    ${(err as Error).message}`);
        }
      }
      if (!(await files.loadCredentials())) console.log(`Sign-in:   not signed in (${RUN} login --server <url>)`);
      else {
        try {
          const claims = readTokenClaims(await new TokenSource(fetch, files).get());
          console.log("Sign-in:   signed in");
          if (claims) {
            // The token's labels, to explain a refusal by the server (never the token itself).
            console.log(`Token:     aud ${claims.aud.join(", ") || "-"}; scope ${claims.scope.join(" ") || "-"}; client ${claims.azp ?? "-"}`);
            for (const problem of tokenProblems(claims)) console.log(`Problem:   ${problem}`);
          }
        } catch (err) {
          console.log(`Sign-in:   ${(err as Error).message}`);
        }
      }
      return 0;
    }

    case "logout": {
      const result = await logout(fetch, files);
      if (!result.wasSignedIn) console.log("Not signed in.");
      else if (result.revoked) console.log("Signed out: the sign-in was revoked and the local file deleted.");
      else console.log("Signed out locally. The sign-in server couldn't be reached to revoke it; it expires unused after 30 days.");
      return 0;
    }

    case "install-service":
      return installService(serviceOptions);

    case "uninstall-service":
      return uninstallService(serviceOptions);

    case "version":
    case "--version":
    case "-v":
      console.log(`${PACKAGE_NAME} ${AGENT_VERSION} (protocol ${PROTOCOL_VERSION}, Node ${process.version})`);
      return 0;

    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;

    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof ServerError) console.error(`Error: ${err.message} (${err.code})`);
    else if (err instanceof NotSignedInError) console.error(err.message);
    else console.error(`Error: ${(err as Error).message}`);
    // 3 = retrying won't help (retired, rejected, not signed in...): systemd doesn't restart it.
    process.exitCode = err instanceof FatalError || err instanceof NotSignedInError ? 3 : 1;
  },
);
