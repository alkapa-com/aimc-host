# Changelog

## aimc-host 0.3.0, aimc-protocol 1.1.0 (unreleased)

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
