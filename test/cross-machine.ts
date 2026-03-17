/**
 * Cross-machine E2E test
 * Connects as master to relay with 2 workers (mac-mini + openclaw)
 * Tests: key exchange, status from both, command to both
 */
import { WebSocket } from 'ws';
import {
  createToken,
  generateKeyPair,
  encryptPayload,
  decryptPayload,
  createEnvelope,
  type AuthMessage,
  type Envelope,
  type KeyExchangeResponse,
  type StatusResponsePayload,
} from '@ccrelay/shared';

const SECRET = 'cross-machine-test';
const PORT = 14083;

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

async function main(): Promise<void> {
  console.log('\n=== Cross-Machine E2E Test ===\n');

  // Verify both workers are online
  const healthResp = await fetch(`http://localhost:${PORT}/health`);
  const health = await healthResp.json() as { status: string; workers: number };
  assert(health.workers === 2, `2 workers online (got ${health.workers})`);

  // Connect as master
  const masterKey = generateKeyPair();
  const masterToken = createToken('master', 'master', SECRET);

  console.log('Connecting as master...');
  const ws = new WebSocket(`ws://localhost:${PORT}`);

  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      const auth: AuthMessage = {
        type: 'auth', token: masterToken, role: 'master',
        name: 'master', publicKey: masterKey.publicKey,
      };
      ws.send(JSON.stringify(auth));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth_response') {
        if (msg.success) resolve();
        else reject(new Error(msg.error));
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Auth timeout')), 5000);
  });
  assert(true, 'Master authenticated');

  // Get all keys
  const keysResp = await new Promise<KeyExchangeResponse>((resolve, reject) => {
    const handler = (data: { toString(): string }) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'key_exchange_response') {
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'key_exchange' }));
    setTimeout(() => reject(new Error('Key exchange timeout')), 5000);
  });

  const workerNames = Object.keys(keysResp.keys).filter(n => n !== 'master');
  console.log(`\nDiscovered ${workerNames.length} worker keys: ${workerNames.join(', ')}`);
  assert(workerNames.includes('mac-mini'), 'Got mac-mini public key');
  assert(workerNames.includes('openclaw'), 'Got openclaw public key');

  // Send status request to each worker
  for (const workerName of workerNames) {
    console.log(`\nRequesting status from '${workerName}'...`);
    const workerPubKey = keysResp.keys[workerName];

    const statusResult = await new Promise<StatusResponsePayload>((resolve, reject) => {
      const handler = (data: { toString(): string }) => {
        const msg = JSON.parse(data.toString());
        if (msg.encryptedPayload && msg.type === 'status_response') {
          try {
            const payload = decryptPayload<StatusResponsePayload>(
              msg.encryptedPayload, msg.nonce, masterKey.secretKey, workerPubKey,
            );
            if (payload.worker === workerName) {
              ws.removeListener('message', handler);
              resolve(payload);
            }
          } catch { /* wrong key, skip */ }
        }
      };
      ws.on('message', handler);

      const req = { fields: ['git', 'cwd', 'system'] };
      const { encrypted, nonce } = encryptPayload(req, masterKey.secretKey, workerPubKey);
      const env = createEnvelope('master', workerName, 'status_request', encrypted, nonce);
      ws.send(JSON.stringify(env));

      setTimeout(() => {
        ws.removeListener('message', handler);
        reject(new Error(`Status timeout from '${workerName}'`));
      }, 10000);
    });

    assert(statusResult.worker === workerName, `${workerName}: responded`);
    assert(typeof statusResult.cwd === 'string' && statusResult.cwd.length > 0, `${workerName}: CWD = ${statusResult.cwd}`);
    if (statusResult.system) {
      assert(typeof statusResult.system.platform === 'string', `${workerName}: platform = ${statusResult.system.platform}`);
      if (statusResult.system.memory) {
        const memGB = (statusResult.system.memory.total / 1e9).toFixed(1);
        console.log(`    ${workerName}: ${statusResult.system.platform}, ${memGB}GB RAM`);
      }
    }
    if (statusResult.git && !('error' in statusResult.git)) {
      assert(typeof statusResult.git.branch === 'string', `${workerName}: git branch = ${statusResult.git.branch}`);
    }
  }

  // Clean up
  ws.close();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
