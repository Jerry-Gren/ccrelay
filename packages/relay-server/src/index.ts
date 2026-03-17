import { startServer } from './server.js';
import { createToken } from '@ccrelay/shared';
import { randomBytes } from 'crypto';

const port = parseInt(process.env.PORT || '4080', 10);
const host = process.env.HOST || '0.0.0.0';
const secret = process.env.RELAY_SECRET || randomBytes(32).toString('hex');
const dbPath = process.env.DB_PATH;

// If no secret was provided, generate and display tokens
if (!process.env.RELAY_SECRET) {
  console.log('[relay] No RELAY_SECRET set — generated a random one for this session.');
  console.log('[relay] Set RELAY_SECRET env var for persistent tokens across restarts.\n');
}

console.log('[relay] === Connection Tokens ===');
console.log(`[relay] Master token: ${createToken('master', 'master', secret)}`);
console.log(`[relay] Worker token (generic): ${createToken('worker', 'worker', secret)}`);
console.log('[relay] Use RELAY_SECRET env var to generate stable tokens.\n');

startServer({ port, host, secret, dbPath });
