import { RelayClient } from './relay-client.js';
import { startMcpServer } from './mcp-server.js';
import { generateKeyPair } from '@ccrelay/shared';

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

const relayUrl = getArg('relay') || process.env.RELAY_URL || 'ws://localhost:4080';
const token = getArg('token') || process.env.RELAY_TOKEN;
const name = getArg('name') || process.env.MASTER_NAME || 'master';

if (!token) {
  console.error('Error: --token or RELAY_TOKEN is required');
  console.error('Usage: ccrelay-master --relay <url> --token <jwt>');
  process.exit(1);
}

// Generate master key pair
const keyPair = generateKeyPair();
console.error(`[master] Connecting to: ${relayUrl}`);

const relay = new RelayClient({
  relayUrl,
  token,
  name,
  publicKey: keyPair.publicKey,
  secretKey: keyPair.secretKey,
});

// Connect to relay, then start MCP server
relay.connect()
  .then(() => {
    console.error('[master] Connected to relay (keys auto-exchanged)');
    return startMcpServer(relay);
  })
  .catch((err) => {
    console.error('[master] Failed to start:', err);
    process.exit(1);
  });

process.on('SIGINT', () => {
  relay.disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  relay.disconnect();
  process.exit(0);
});
