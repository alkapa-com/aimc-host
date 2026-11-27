# aimc-host

Lend your GPU to an aimc server. `aimc-host` connects the [Ollama](https://ollama.com) on your
machine to the server: the server sends chat requests for the models you offer, your Ollama
answers them. The server's admin approves your machine and sets what you earn for it.

- **Outgoing HTTPS only.** You open no ports; the agent connects to the server.
- **Only what you offer.** It runs only the models you list, and calls only four Ollama
  endpoints: chat, the installed models, the loaded models, and the version. The server can't
  make it pull, delete or change anything on your machine.
- **Nothing private in the log.** It logs job ids, models, token counts and times; never
  prompts, answers or images.

## What you need

- An account on an aimc server, approved by its admin, and the server's address
  (`https://...`).
- [Node.js](https://nodejs.org) 22.12 or newer.
- Ollama, with the models you want to offer (`ollama pull <model>`). An NVIDIA GPU is
  optional; with `nvidia-smi` the agent reports its name, memory, load and temperature.

## Install

```bash
npm install -g aimc-host
```

Or run it without installing: put `npx` in front of every command below
(`npx aimc-host login ...`).

## First time: sign in, register, choose models

These three are needed once per machine. The agent remembers your sign-in and settings.

```bash
aimc-host login --server https://your-server.example
```

It prints a link and a short code. Open the link on any device (your phone works), sign in and
confirm the code. The agent says **Signed in**.

```bash
aimc-host register --name my-desktop
```

This adds your machine as a host, **waiting for an admin's approval**.

```bash
aimc-host config --models llama3.2:3b,gemma3:12b
```

The models you offer, comma-separated, as `ollama list` names them. It warns about any that
aren't installed.

## Run

```bash
aimc-host start
```

While the host waits for approval, the agent says so and checks once a minute. Once approved it
prints **Connected** and takes requests; each finished job shows one line (model, tokens, time).
Ctrl+C stops it cleanly within a few seconds; so does `aimc-host stop` from another terminal.

`aimc-host status` says first whether the agent runs, where (a terminal or the service), since
when and how it is doing (connected, waiting for approval, paused, reconnecting; jobs done).
Then your settings, Ollama, the GPU, whether the server is reachable, and your sign-in.
`aimc-host help` lists every command.

**One copy per host.** A second `aimc-host start` on the same machine is refused, and so is a
second copy elsewhere (another machine with the same settings): the server lets one run of the
agent connect per host. If the other copy was stopped a moment ago, the new one checks again for
a minute before it gives up.

**One host per machine.** `register` refuses when this machine already is one of your hosts and
names it; use it with `aimc-host config --host-id <id>`, or add `--force` for a second host.

## With a host token (Docker and other unattended setups)

Instead of `login` and `register`, the agent can run with a **host token**: made on the website
(Hosts, **Add a host with a token**, or **New token** on an existing host), shown once, valid for
that one host until you make a new one. A new host still waits for an admin's approval.

The ready-made way is the Docker image `alkapa/aimc-host`, next to an Ollama container:
see [docker/README.md](https://github.com/alkapa-com/aimc-host/tree/main/docker#readme), with
compose files for NVIDIA, AMD (ROCm), Windows and Mac.

The installed CLI works the same way: set these and run `aimc-host start`.

| Variable | |
|---|---|
| `AIMC_SERVER_URL` | the server, `https://...` |
| `AIMC_HOST_TOKEN_FILE` | a file holding the token (wins over `AIMC_HOST_TOKEN`) |
| `AIMC_HOST_TOKEN` | the token itself |
| `AIMC_MODELS` | the models you offer, comma-separated |
| `AIMC_OLLAMA_URL` | your Ollama (default `http://127.0.0.1:11434`) |
| `AIMC_MAX_CONCURRENT` | jobs at once, 1 to 32 (default 1) |

Each variable wins over the same setting in `config.json`; the host is the one the token names.
`login`, `register` and `install-service` are refused while a token is set. The agent prints only
the token's start (`aimc_host_` and 8 characters of the host id), as the website shows it. If the server refuses the token, the agent says so once and
tries again every 5 minutes; with `AIMC_HOST_TOKEN_FILE`, it also reads the file again every 30
seconds, so putting a new token there is enough.

## Keep it running

### Linux (systemd)

```bash
aimc-host install-service --copy-settings
```

It asks for your password (sudo), then:
1. creates a system user `ai-my-card-host` with a private folder `/var/lib/ai-my-card-host`;
2. copies the agent to `/opt/aimc-host`, and Node too if yours lives in your home folder (nvm).
   The service may not read home folders;
3. with `--copy-settings`, gives the service a copy of your sign-in and settings;
4. installs, enables and starts the unit `ai-my-card-host-agent` (started at boot, restarted
   30 s after a crash or a network problem).

From then on `aimc-host start` and `aimc-host stop` start and stop the service (through sudo),
and `aimc-host status` shows it, no sudo needed. `aimc-host start --foreground` runs the agent in
your terminal instead, once the service is stopped. Watch the service with
`journalctl -u ai-my-card-host-agent -f`.

Without `--copy-settings`, set the service up as the service itself:

```bash
aimc-host service login --server https://your-server.example
```

Then the same with `register --name ...` and `config --models ...`, and `aimc-host start`. `aimc-host service status` shows the service's
settings and sign-in.

`aimc-host install-service --dry-run` shows what it would do, without changing anything.
`aimc-host uninstall-service` removes it (`--purge` also deletes its sign-in and settings).

If the server said retrying is pointless (host retired, account suspended, signed out, agent too
old), the agent exits with code 3 and the service doesn't restart it; the log says why.

### Windows

Sign in, register and choose models first (above). Then, in a normal terminal:

```powershell
aimc-host install-service
```

It creates the Task Scheduler task `aimc-host` for your account and starts the agent. From then
on the agent starts by itself when you log in (a console window flashes for a moment), runs
hidden with your settings and sign-in while you are logged in, and is started again 30 s after a
crash. Its output goes to `agent.log` in your settings folder. Until Ollama runs, it waits.

`aimc-host start`, `stop` and `status` work as on Linux. `aimc-host install-service --dry-run`
shows what it would do; `aimc-host uninstall-service` removes the task. No administrator rights
are needed; if a company policy forbids creating tasks, the agent says to run the command in an
administrator terminal. Run `install-service` again after switching Node versions (it records
which `node.exe` to use).

Why at log-in, not at boot: Ollama on Windows runs while you are logged in, and Windows can't run
"whether logged in or not" tasks for Microsoft Entra ID (work) accounts.

Without the service, keep `aimc-host start` running in a terminal (or put a shortcut to
`cmd.exe /k aimc-host.cmd start` in your Startup folder, Win+R `shell:startup`).

If PowerShell says *running scripts is disabled on this system*, run `aimc-host.cmd` instead
of `aimc-host`, or allow signed scripts for your user:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## Update

```bash
npm install -g aimc-host@latest
```

Then restart the agent (`aimc-host stop`, then `aimc-host start`). As a Linux service, run
`aimc-host install-service` again (it replaces the copy and restarts the service); as a Windows
task, `aimc-host stop`, then `aimc-host start`. Your sign-in and settings stay.

When the server recommends a newer agent, the agent says so once, with the command to run. When
the server needs a newer one, the agent stops and says which version.

## Sign out

```bash
aimc-host logout
```

It revokes the sign-in at the sign-in server, then deletes it from this machine.

## Your sign-in (and a host token) is a secret

`login` stores a long-lived sign-in (an OAuth refresh token) in `credentials.json`:

| | Folder |
|---|---|
| Windows | `%APPDATA%\ai-my-card-host` |
| Linux, macOS | `~/.config/ai-my-card-host` (or `$XDG_CONFIG_HOME/ai-my-card-host`), mode 600 |
| The Linux service | `/var/lib/ai-my-card-host/ai-my-card-host`, readable only by the service user |

Anyone with that file can act as your host. Don't copy it around, don't commit it; if it
leaked, run `aimc-host logout` (or ask the admin to revoke it). It ends by itself when unused
for 30 days.

The same goes for a host token. If one leaked, make a new token for the host on the website:
the old one stops working at once.

## Troubleshooting

- **"... doesn't look like an aimc server":** check the address (`https://`, no path).
- **"Is Ollama running?":** start Ollama; if it listens elsewhere,
  `aimc-host config --ollama http://<host>:11434`.
- **The server refuses the sign-in:** `aimc-host status` shows a **Problem** line; send it to
  the server's admin.
- **Jobs fail for one model:** check `ollama list` has exactly the name you offer.

## How it works

`start` says hello to the server (versions, offered models, GPU), opens a job stream
(Server-Sent Events), and runs each job on your Ollama, sending the answer back in small
numbered batches. A heartbeat with GPU telemetry goes out every 15 seconds. The messages are
defined in [aimc-protocol](https://www.npmjs.com/package/aimc-protocol).

## License

MIT
