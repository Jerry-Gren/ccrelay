import { connect, disconnect } from './connection.js';
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
const name = getArg('name') || process.env.WORKER_NAME || `worker-${process.pid}`;
const cwd = getArg('cwd') || process.cwd();

if (!token) {
  console.error('Error: --token or RELAY_TOKEN is required');
  console.error('Usage: ccrelay-worker --relay <url> --token <jwt> --name <name>');
  process.exit(1);
}

// Generate worker key pair
const keyPair = generateKeyPair();
console.log(`[worker] Name: ${name}`);
console.log(`[worker] CWD: ${cwd}`);
console.log(`[worker] Connecting to: ${relayUrl}`);

connect({
  relayUrl,
  token,
  name,
  publicKey: keyPair.publicKey,
  secretKey: keyPair.secretKey,
  cwd,
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[worker] Shutting down...');
  disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  disconnect();
  process.exit(0);
});
