import { connect, disconnect } from './connection.js';
import { generateKeyPair } from '@ccrelay/shared';

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

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
  console.error(`${c.yellow}Error: --token or RELAY_TOKEN is required${c.reset}`);
  console.error(`Usage: ccrelay-worker --relay <url> --token <jwt> --name <name>`);
  process.exit(1);
}

// Generate worker key pair
const keyPair = generateKeyPair();

console.log(`${c.cyan}${c.bold}ccrelay worker${c.reset}`);
console.log(`  ${c.dim}name:${c.reset}  ${c.bold}${name}${c.reset}`);
console.log(`  ${c.dim}cwd:${c.reset}   ${cwd}`);
console.log(`  ${c.dim}relay:${c.reset} ${relayUrl}`);
console.log('');

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
  console.log(`\n${c.dim}shutting down...${c.reset}`);
  disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  disconnect();
  process.exit(0);
});
