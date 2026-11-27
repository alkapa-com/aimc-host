# aimc-host

Lend your GPU to an aimc server: a small agent that connects your local
[Ollama](https://ollama.com) to the server over outgoing HTTPS.

| Package | What | |
|---|---|---|
| [`aimc-host`](packages/host) | the agent, a command-line tool | `npm install -g aimc-host` |
| [`aimc-protocol`](packages/protocol) | the messages between server and agent (zod schemas) | `npm install aimc-protocol` |

**Using the agent:** see [packages/host/README.md](packages/host/README.md).
**In Docker** (the image `alkapa/aimc-host`, with a host token from the website): see
[docker/README.md](docker/README.md).

## Development

Node 22.12 or newer.

```bash
npm ci
```

```bash
npm run typecheck
```

```bash
npm test
```

Run the agent from source (no build needed):

```bash
node scripts/dev.mjs status
```

Build and check the packages the way npm installs them (packs both, installs the tarballs into a
throwaway folder and runs the CLI):

```bash
npm run build
```

```bash
node scripts/smoke.mjs
```

Try your build for real: `npm pack -w aimc-protocol -w aimc-host`, then
`npm install -g ./aimc-protocol-<version>.tgz ./aimc-host-<version>.tgz`.

### Layout

- `packages/protocol`: `src/agent.ts` (the API's schemas), `src/sse.ts` (Server-Sent Events).
  Built with `tsc` to `dist/` with type declarations.
- `packages/host`: the CLI. `src/cli.ts` (commands), `auth.ts` (device sign-in, tokens),
  `runner.ts` (`start`), `ollama.ts`, `server-client.ts`, `service.ts` (systemd),
  `telemetry.ts` (nvidia-smi). Built with `tsc` to `dist/`.
- `Dockerfile`: the agent's image, built from these sources (`npm pack`, then the tarballs
  installed globally, as npm would). `docker/`: compose examples and the image's README.
  `docker build -t aimc-host .` builds it locally.
- The sources import with `.ts` extensions; `tsc` rewrites them to `.js`. In this repository the
  host sees the protocol's source through the `aimc-source` export condition, so tests and
  `scripts/dev.mjs` need no build.

### Versions and releases

- `aimc-protocol` follows the protocol: 1.x is protocol version 1, which only grows (optional
  fields, new events and error codes). A breaking change would be 2.0.0.
- `aimc-host` follows semver on its commands and settings. Its settings folder and service
  names stay compatible across versions.
- To release: bump the versions in `packages/*/package.json`, note it in `CHANGELOG.md`, merge,
  then publish a GitHub release. The release workflow publishes every package whose version
  isn't on npm yet, protocol first, with npm provenance. `node scripts/publish.mjs --dry-run`
  shows what it would publish. Then it builds the Docker image for linux/amd64 and linux/arm64
  and pushes it to Docker Hub as `<host version>` and `latest` (a pre-release only as its version).

### Docker Hub (one-time setup)

The workflow's `docker` job is skipped until this is done:

1. A Docker Hub account (or organization) that owns the repository `alkapa/aimc-host`; create
   the repository as public, with the description from `docker/README.md`.
2. A Docker Hub personal access token for that account, access **Read & Write**, named after
   this repository.
3. On GitHub, in this repository's settings: the environment `docker` with the secret
   `DOCKERHUB_TOKEN` (the token from step 2); optionally a required reviewer, like `npm`.
4. The repository variable `DOCKERHUB_USERNAME` (the account from step 1); optionally
   `DOCKERHUB_IMAGE` for another image name than `alkapa/aimc-host`.

The next release then pushes the image; to push one for the current version at once, run the
Release workflow by hand (it skips the npm packages already published).

## License

MIT
