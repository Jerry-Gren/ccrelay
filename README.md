# ccrelay

Control multiple Claude Code sessions across different machines from a single interface.

```
Worker A (mac-mini)  ◄──WSS──►  Relay Server (cloud)  ◄──WSS──►  Master (your Claude Code)
Worker B (gpu-box)   ◄──WSS──►       (can't read
Worker C (openclaw)  ◄──WSS──►        messages)
```

You talk to your master Claude Code session normally. It delegates work to workers on other machines — each running their own full Claude Code with local file access, git, and tools.

## Quick Start

### 1. Deploy the relay

The relay is a lightweight message broker. Deploy it anywhere publicly reachable.

**Fly.io (recommended):**

```bash
# Install flyctl if you haven't: https://fly.io/docs/flyctl/install/
cd ccrelay
fly launch --no-deploy
fly secrets set RELAY_SECRET="$(openssl rand -hex 32)"
fly volumes create ccrelay_data --region sjc --size 1
fly deploy
```

Your relay is now live at `wss://your-app-name.fly.dev`.

**Docker (self-hosted):**

```bash
RELAY_SECRET="$(openssl rand -hex 32)" docker compose up -d
```

**Local (for testing):**

```bash
npm install && npm run build
RELAY_SECRET="my-secret" node packages/relay-server/dist/index.js
```

### 2. Get your tokens

When the relay starts, it prints two JWT tokens:

```
[relay] === Connection Tokens ===
[relay] Master token: eyJ...
[relay] Worker token: eyJ...
```

Copy both. As long as you keep the same `RELAY_SECRET`, these tokens stay stable across restarts.

### 3. Start workers

Run this on every machine you want to control:

```bash
git clone https://github.com/Stanleytowne/ccrelay.git
cd ccrelay && npm install && npm run build

RELAY_TOKEN="<worker-token>" node packages/worker-daemon/dist/index.js \
  --relay wss://your-app-name.fly.dev \
  --name my-machine \
  --cwd ~/my-project
```

| Flag | Description | Default |
|------|-------------|---------|
| `--relay <url>` | Relay server URL | `ws://localhost:4080` |
| `--token <jwt>` | Worker token (or set `RELAY_TOKEN`) | required |
| `--name <name>` | Worker name (how you'll refer to it) | `worker-{pid}` |
| `--cwd <path>` | Working directory for Claude Code | current directory |

You can run multiple workers on the same machine with different names and directories:

```bash
RELAY_TOKEN="..." node packages/worker-daemon/dist/index.js --name frontend --cwd ~/frontend &
RELAY_TOKEN="..." node packages/worker-daemon/dist/index.js --name backend --cwd ~/backend &
```

### 4. Add the master to Claude Code

Run this once on the machine where you use Claude Code:

```bash
claude mcp add ccrelay -- node /path/to/ccrelay/packages/master-mcp/dist/index.js \
  --relay wss://your-app-name.fly.dev \
  --token "<master-token>"
```

Done. Start a Claude Code session and talk to your workers.

## Usage

Once configured, just talk naturally in your master Claude Code session:

```
You: check the status of all workers

You: ask gpu-box to run the training script

You: tell frontend to fix the failing test in src/auth.test.ts

You: ask backend and frontend to both check their git status
```

Claude uses these MCP tools automatically:

| Tool | What it does |
|------|-------------|
| `list_workers` | Show all connected workers and their status |
| `worker_status` | Get git, CWD, and system info from a worker (zero tokens) |
| `send_command` | Send a prompt to a worker and wait for the result |
| `broadcast_command` | Send a prompt to multiple workers at once |
| `cancel_command` | Abort a running command |
| `list_sessions` | Show recent task history |

Each `send_command` runs a full Claude Code session on the worker machine — it can read files, write code, run tests, use git, and everything else Claude Code does.

## How It Works

**Architecture:** Workers make outbound WebSocket connections to the relay. The relay routes messages between workers and the master. Since all connections are outbound, it works through NATs and firewalls without any port forwarding.

**E2E encryption:** All message content is encrypted with X25519 + XSalsa20-Poly1305 (NaCl box). Keys are exchanged automatically through the relay. The relay only sees opaque ciphertext — it cannot read any prompts, code, or results.

**Token efficiency:** Workers use the Claude Agent SDK with session resume. Repeated commands to the same worker reuse the Claude session context, avoiding re-sending conversation history. Only the new prompt is sent over the relay.

**Auth:** JWTs with 24h expiry, derived from your `RELAY_SECRET`. Workers and masters authenticate on connect.

## Keeping Workers Running

Use `tmux`, `screen`, or a systemd service:

```ini
# /etc/systemd/system/ccrelay-worker.service
[Unit]
Description=ccrelay worker
After=network.target

[Service]
ExecStart=/usr/bin/node /home/user/ccrelay/packages/worker-daemon/dist/index.js \
  --relay wss://your-app-name.fly.dev \
  --name my-machine \
  --cwd /home/user/project
Environment=RELAY_TOKEN=<worker-token>
Restart=always
User=user

[Install]
WantedBy=multi-user.target
```

## Environment Variables

| Variable | Component | Description |
|----------|-----------|-------------|
| `RELAY_SECRET` | Relay | Secret for JWT signing. Set this for stable tokens. |
| `PORT` | Relay | Listen port (default: `4080`) |
| `HOST` | Relay | Listen host (default: `0.0.0.0`) |
| `DB_PATH` | Relay | SQLite database path |
| `RELAY_TOKEN` | Worker/Master | JWT token (alternative to `--token`) |
| `RELAY_URL` | Worker/Master | Relay URL (alternative to `--relay`) |
| `WORKER_NAME` | Worker | Worker name (alternative to `--name`) |

## Security

- **E2E encrypted**: Relay cannot read message content
- **JWT auth**: 24h expiry tokens derived from your secret
- **Rate limiting**: 60 envelopes/min, 200 messages/min per connection; 20 connections/IP; 500 total
- **Sender validation**: Relay rejects spoofed sender names
- **Credential isolation**: Each worker uses its own Claude OAuth. No API keys cross the relay.
- **Bounded queues**: Max 100 offline messages per worker

## Project Structure

```
packages/
  shared/          # Types, crypto (tweetnacl), JWT, protocol constants
  relay-server/    # Hono + WebSocket relay with SQLite message queue
  worker-daemon/   # CLI that executes commands via Claude Agent SDK
  master-mcp/      # MCP server exposing relay tools to Claude Code
```

## Development

```bash
git clone https://github.com/Stanleytowne/ccrelay.git
cd ccrelay
npm install
npm run build

# Run tests
npx tsx test/integration.ts
npx tsx test/e2e-local.ts
```

## License

MIT
