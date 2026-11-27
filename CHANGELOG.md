# Changelog

## aimc-host 0.5.0 (unreleased)

- Host token mode: with a token made on the website for one host, the agent runs without
  `login` and `register`. Settings from the environment: `AIMC_SERVER_URL`, `AIMC_HOST_TOKEN` or
  `AIMC_HOST_TOKEN_FILE` (the file wins), `AIMC_MODELS`, `AIMC_OLLAMA_URL`,
  `AIMC_MAX_CONCURRENT`; each wins over `config.json`. The token is sent as a bearer token on the
  same agent API; only its start (`aimc_host_` and 8 characters of the host id, as the website shows it) is
  ever printed. No machine id is sent in this
  mode.
- A refused host token (401) is not retried at once: the agent says so once, then tries again
  every 5 minutes, and picks up a new token from `AIMC_HOST_TOKEN_FILE` within 30 seconds. A
  stream the server closes (after an hour with a token, or at once when the token is replaced)
  is reopened as before.
  `status` shows the state "the server refused the host token".
- The Docker image `alkapa/aimc-host` (linux/amd64, linux/arm64): the agent only, as a non-root
  user, `aimc-host start` in the foreground, logs to stdout, settings volume `/config`, a health
  check. Compose examples for NVIDIA, AMD (ROCm) and native Ollama (Mac, Windows) in `docker/`.
- In a container the agent waits for Ollama, its update hint says to pull the new image, and a
  restarted container takes over the run file its earlier run left behind.
- `help` and `version` work even when the settings are broken.

## aimc-host 0.4.0 (2026-11-26)

- Windows: `install-service` creates the Task Scheduler task `aimc-host`, which starts the agent
  hidden when you log in; a supervisor starts it again after a crash, and its output goes to
  `agent.log` in the settings folder. `uninstall-service` removes the task. `start`, `stop` and
  `status` handle it like the Linux service. No administrator rights needed; if a policy refuses,
  the agent says to use an administrator terminal.
- `start` and `install-service` check that the agent really started, and show the log if not.
- As a service (Linux and Windows), the agent waits for Ollama instead of exiting when Ollama
  isn't running yet.
- A second copy refused on this machine exits with code 4 (was 1).

## aimc-host 0.3.0, aimc-protocol 1.1.0 (2026-11-26)

aimc-host:
- `status` says first whether the agent runs (in a terminal or as the service, its pid, since
  when) and how it is doing: connected, waiting for approval, paused, reconnecting, jobs done.
- `stop`: stops the agent, whether it runs in another terminal or as the Linux service.
- One copy per host: a second `start` is refused, on this machine at once, and elsewhere by the
  server. The refused copy checks again for a minute (the other may just have been stopped),
  then exits with code 3.
- With the Linux service installed, `start` and `stop` start and stop it; `start --foreground`
  runs in the terminal instead. Re-run `install-service` after updating: the new unit lets
  `status` read the service's state without sudo.
- `register` refuses when this machine already is one of your hosts (only a hash of the machine
  id is sent); `--force` registers a second host anyway. `config --host-id` uses an existing one.
- Knows it runs as the service only under the service (a desktop terminal can carry systemd's
  INVOCATION_ID too), for the right update hint.

aimc-protocol:
- Added: `AGENT_RUN_HEADER` (`aimc-run-id`), the error codes `host_already_connected` and
  `machine_already_registered` (409), optional `machineId` in `registerHostRequest` and
  `helloRequest`, optional `force` in `registerHostRequest`.

## aimc-host 0.2.0, aimc-protocol 1.0.0 (2026-11-26)

First release on npm. Before, the agent was a download from the server.

aimc-host:
- Installs with `npm install -g aimc-host` (or `npx aimc-host`); runs compiled JavaScript.
- Same commands, settings folder and sign-in as before: existing hosts keep working.
- `install-service`, `uninstall-service`, `service <command>`: the agent as a systemd service on
  Linux, including when Node comes from nvm.
- `version`; `status` shows the agent's version.
- Says when the server recommends a newer agent, and stops with a clear message when the server
  needs one.

aimc-protocol:
- Protocol version 1, as used by agents 0.1.x.
- Added: `helloResponse.latestAgentVersion` and `helloResponse.minAgentVersion` (optional), the
  error code `agent_outdated` (426).
