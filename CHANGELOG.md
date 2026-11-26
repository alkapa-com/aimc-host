# Changelog

## aimc-host 0.2.0, aimc-protocol 1.0.0 (unreleased)

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
