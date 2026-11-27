# aimc-host in Docker

Lend your GPU to an aimc server from a container. The image `alkapa/aimc-host` holds only the
host agent; Ollama runs next to it in its own container, or natively on the machine.

The container needs no `login` or `register`: it runs with a **host token** made on the website.
Like the agent installed with npm, it makes outgoing HTTPS connections only (you open no ports),
runs only the models you list, and never logs prompts or answers.

## 1. Get a host token

On the website, open **Hosts**:

- **Add a host with a token** makes a new host and its token; or
- **New token** on one of your hosts makes a new token for it (the old one stops working).

The token looks like `aimc_host_<32 characters>_<43 characters>` and is shown **only once**.
It is a secret, like a password: anyone with it can act as this host. Save it in a file named
`aimc-host-token` next to the compose file (one line), not in the compose file itself.

A new host waits for an admin's approval, as with `aimc-host register`.

## 2. Pick a compose file

| Your machine | File |
|---|---|
| Linux with an NVIDIA GPU | [`compose.yaml`](compose.yaml) (needs the NVIDIA Container Toolkit) |
| Windows with an NVIDIA GPU | [`compose.yaml`](compose.yaml), with Docker Desktop and its WSL 2 engine |
| Linux with an AMD GPU | [`compose.amd.yaml`](compose.amd.yaml) (`ollama/ollama:rocm`, `/dev/kfd` and `/dev/dri`) |
| Mac, or Ollama already installed | [`compose.native-ollama.yaml`](compose.native-ollama.yaml) (only the agent in Docker) |

In it, set `AIMC_SERVER_URL` to the server's address and `AIMC_MODELS` to the models you offer.

```bash
docker compose up -d
```

```bash
docker compose exec ollama ollama pull gemma3:12b
```

(With another file, add `-f <file>` to each command. With native Ollama, pull with `ollama pull`.)

```bash
docker compose logs -f agent
```

The log says **waiting for an admin to approve this host** until it is approved, then
**Connected** and one line per job. `docker compose exec agent aimc-host status` shows what the
agent does and the settings it uses.

### Notes per system

- **NVIDIA, Linux:** install the NVIDIA driver and the
  [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html),
  then `sudo nvidia-ctk runtime configure --runtime=docker` and restart Docker.
  `gpus: all` needs Docker Compose 2.30 or newer; on older ones use
  `deploy.resources.reservations.devices` (driver `nvidia`, capabilities `[gpu]`).
- **AMD, Linux:** ROCm support depends on the card; Ollama's documentation lists the cards and
  the `HSA_OVERRIDE_GFX_VERSION` workaround. The website shows no GPU details for AMD hosts
  yet (the agent reads them with `nvidia-smi`).
- **Windows:** Docker Desktop with the WSL 2 engine passes NVIDIA GPUs to containers with a
  current NVIDIA driver on Windows (no driver inside WSL). AMD GPUs can't be used from Docker on
  Windows: run the Ollama app natively and use `compose.native-ollama.yaml`. Or skip Docker and
  use the [`aimc-host` CLI](../packages/host/README.md), which can also start at log-in.
- **Mac:** Docker on a Mac can't use the GPU. Run the [Ollama app](https://ollama.com) natively
  (it uses Metal) and only the agent in Docker with `compose.native-ollama.yaml`;
  `host.docker.internal` reaches the Mac's Ollama. The image runs natively on Apple silicon.
- **Linux, Ollama installed natively:** `compose.native-ollama.yaml` with `network_mode: host`
  and `AIMC_OLLAMA_URL: http://127.0.0.1:11434`.

## Settings

| Variable | |
|---|---|
| `AIMC_SERVER_URL` | the server, `https://...` (required) |
| `AIMC_HOST_TOKEN_FILE` | a file holding the token, such as a Docker secret (`/run/secrets/...`) |
| `AIMC_HOST_TOKEN` | the token itself, if you can't use a file. `AIMC_HOST_TOKEN_FILE` wins when both are set |
| `AIMC_MODELS` | the Ollama models you offer, comma-separated, as `ollama list` names them (required) |
| `AIMC_OLLAMA_URL` | where Ollama listens, e.g. `http://ollama:11434` (default `http://127.0.0.1:11434`) |
| `AIMC_MAX_CONCURRENT` | jobs at once, 1 to 32 (default 1); the server may allow fewer |

The host is the one the token names. The agent prints only the token's start
(`aimc_host_` and 8 characters of the host id), as the website shows it; never the secret part.

The volume at `/config` holds the agent's run state (for `status` and the health check). It
needs no backup: the token is all the agent needs.

The token file must be readable by the agent, which runs as user id 1000 (not root). On Linux:
`sudo chown 1000 aimc-host-token && chmod 600 aimc-host-token`. Hosting panels that take
"secrets" or "environment variables" usually let you set `AIMC_HOST_TOKEN` directly instead.

Plain `docker run` works too:

```bash
docker run -d --name aimc-host --restart unless-stopped -v aimc-host:/config -e AIMC_SERVER_URL=https://your-server.example -e AIMC_HOST_TOKEN_FILE=/run/secrets/token -v "$PWD/aimc-host-token:/run/secrets/token:ro" -e AIMC_OLLAMA_URL=http://<ollama-address>:11434 -e AIMC_MODELS=gemma3:12b alkapa/aimc-host:latest
```

## When something is wrong

- **"The server refused the host token":** the token was replaced by a newer one, deleted with
  its host, or copied wrongly. Make a new one on the website (**New token** on the host) and put
  it into the token file: the agent reads the file again every 30 seconds and carries on. With
  `AIMC_HOST_TOKEN`, change it and recreate the container (`docker compose up -d`). Until then the
  agent tries again every 5 minutes, and the health check says *unhealthy*.
- **"Waiting for Ollama":** check `AIMC_OLLAMA_URL` and that Ollama runs
  (`docker compose ps`).
- **The agent exits and restarts every minute:** the log's last lines say why. It stops for
  good reasons only (the host was retired or rejected, the account is suspended, this agent
  version is too old); Docker restarts it anyway, so fix the cause or stop the container.
- **"Offered but not installed in Ollama":** pull the model, or fix its name in `AIMC_MODELS`.

## Update

```bash
docker compose pull
```

```bash
docker compose up -d
```

When the server recommends a newer agent, the log says so once.

## Without a token

The image can also use the sign-in of the npm agent (a code you confirm in a browser), stored in
the `/config` volume. Remove the `environment` and `secrets` of the agent from the compose file
first: with a token set, `login` and `register` are refused, and the `AIMC_*` settings apply
only with a token. Then:

```bash
docker compose run --rm agent login --server https://your-server.example
```

```bash
docker compose run --rm agent register --name my-gpu-box
```

```bash
docker compose run --rm agent config --ollama http://ollama:11434 --models gemma3:12b
```

and `docker compose up -d`. A token is simpler: nothing to sign in to, nothing that expires
when unused.
