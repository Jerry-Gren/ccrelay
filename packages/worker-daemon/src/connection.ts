import WebSocket from 'ws';
import {
  type AuthMessage,
  type AuthResponse,
  type Envelope,
  type HeartbeatMessage,
  type KeyExchangeResponse,
  type CommandPayload,
  type StatusRequestPayload,
  type WireMessage,
  HEARTBEAT_INTERVAL_MS,
  reconnectDelay,
  decryptPayload,
  encryptPayload,
  createEnvelope,
} from '@ccrelay/shared';
import { executeCommand, cancelTask, getCumulativeUsage, getActiveTasks } from './executor.js';
import { execSync } from 'child_process';
import os from 'os';

interface ConnectionOptions {
  relayUrl: string;
  token: string;
  name: string;
  publicKey: string;
  secretKey: string;
  cwd?: string;
}

let ws: WebSocket | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;
let shouldReconnect = true;
let connectionOptions: ConnectionOptions;

// Sender public keys learned via key exchange
const knownKeys = new Map<string, string>();

export function connect(options: ConnectionOptions): void {
  connectionOptions = options;
  shouldReconnect = true;
  doConnect();
}

function doConnect(): void {
  const opts = connectionOptions;
  console.log(`[worker] Connecting to ${opts.relayUrl}...`);

  ws = new WebSocket(opts.relayUrl);

  ws.on('open', () => {
    console.log('[worker] Connected, authenticating...');
    const authMsg: AuthMessage = {
      type: 'auth',
      token: opts.token,
      role: 'worker',
      name: opts.name,
      publicKey: opts.publicKey,
    };
    ws!.send(JSON.stringify(authMsg));
  });

  ws.on('message', (data) => {
    let msg: WireMessage;
    try {
      msg = JSON.parse(data.toString()) as WireMessage;
    } catch {
      console.error('[worker] Invalid message received');
      return;
    }

    handleMessage(msg);
  });

  ws.on('close', (code, reason) => {
    console.log(`[worker] Disconnected: ${code} ${reason.toString()}`);
    stopHeartbeat();
    if (shouldReconnect) {
      const delay = reconnectDelay(reconnectAttempt++);
      console.log(`[worker] Reconnecting in ${Math.round(delay / 1000)}s...`);
      setTimeout(doConnect, delay);
    }
  });

  ws.on('error', (err) => {
    console.error('[worker] WebSocket error:', err.message);
  });
}

function handleMessage(msg: WireMessage): void {
  if (msg.type === 'auth_response') {
    const authResp = msg as AuthResponse;
    if (authResp.success) {
      console.log(`[worker] Authenticated as '${connectionOptions.name}'`);
      reconnectAttempt = 0;
      startHeartbeat();
      // Request all known public keys (to learn the master's key)
      ws?.send(JSON.stringify({ type: 'key_exchange' }));
    } else {
      console.error(`[worker] Auth failed: ${authResp.error}`);
      shouldReconnect = false;
      ws?.close();
    }
    return;
  }

  // Handle key exchange response
  if (msg.type === 'key_exchange_response') {
    const resp = msg as KeyExchangeResponse;
    for (const [name, key] of Object.entries(resp.keys)) {
      if (name !== connectionOptions.name) {
        knownKeys.set(name, key);
        console.log(`[worker] Learned public key for '${name}'`);
      }
    }
    return;
  }

  // Handle envelope messages (commands from master)
  if ('encryptedPayload' in msg) {
    const envelope = msg as Envelope;
    handleEnvelope(envelope);
    return;
  }
}

function getSenderKey(senderName: string): string | undefined {
  return knownKeys.get(senderName);
}

async function fetchKeyAndWait(name: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const handler = (data: { toString(): string }) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'key_exchange_response' && msg.keys[name]) {
        knownKeys.set(name, msg.keys[name]);
        console.log(`[worker] Learned public key for '${name}'`);
        ws?.removeListener('message', handler);
        clearTimeout(timer);
        resolve(msg.keys[name]);
      }
    };
    const timer = setTimeout(() => {
      ws?.removeListener('message', handler);
      resolve(undefined);
    }, 5000);
    ws?.on('message', handler);
    ws?.send(JSON.stringify({ type: 'key_exchange', requestKeys: [name] }));
  });
}

async function resolveKey(name: string): Promise<string | undefined> {
  let key = getSenderKey(name);
  if (!key) {
    console.log(`[worker] No public key for sender '${name}', fetching...`);
    key = await fetchKeyAndWait(name);
  }
  return key;
}

function tryDecrypt<T>(encrypted: string, nonce: string, secretKey: string, publicKey: string): T | null {
  try {
    return decryptPayload<T>(encrypted, nonce, secretKey, publicKey);
  } catch {
    return null;
  }
}

async function handleEnvelope(envelope: Envelope): Promise<void> {
  const opts = connectionOptions;
  let senderKey = await resolveKey(envelope.from);
  if (!senderKey) {
    console.error(`[worker] Could not get key for '${envelope.from}', dropping envelope`);
    return;
  }

  // Try decrypt; on failure, refresh key and retry once (sender may have reconnected with new key)
  let testDecrypt = tryDecrypt<unknown>(envelope.encryptedPayload, envelope.nonce, opts.secretKey, senderKey);
  if (testDecrypt === null) {
    console.log(`[worker] Decryption failed for '${envelope.from}', refreshing key...`);
    const freshKey = await fetchKeyAndWait(envelope.from);
    if (freshKey && freshKey !== senderKey) {
      senderKey = freshKey;
      testDecrypt = tryDecrypt<unknown>(envelope.encryptedPayload, envelope.nonce, opts.secretKey, senderKey);
    }
    if (testDecrypt === null) {
      console.error(`[worker] Decryption still failed for '${envelope.from}', dropping envelope`);
      return;
    }
  }

  try {
    if (envelope.type === 'command') {
      const payload = decryptPayload<CommandPayload>(
        envelope.encryptedPayload,
        envelope.nonce,
        opts.secretKey,
        senderKey,
      );

      console.log(`[worker] Received command: ${payload.prompt.slice(0, 80)}...`);

      // Use sender name as session key so consecutive commands from the same
      // master share a continuous Claude session (session resume)
      const taskId = envelope.from;

      try {
        const result = await executeCommand(taskId, payload.prompt, {
          model: payload.options?.model,
          cwd: payload.options?.cwd || opts.cwd,
          timeout: payload.options?.timeout,
          onProgress: (chunk) => {
            const { encrypted, nonce } = encryptPayload(
              { taskId, chunk, done: false },
              opts.secretKey,
              senderKey,
            );
            const chunkEnvelope = createEnvelope(
              opts.name,
              envelope.from,
              'stream_chunk',
              encrypted,
              nonce,
            );
            ws?.send(JSON.stringify(chunkEnvelope));
          },
        });

        const resultPayload = {
          taskId: envelope.id,
          status: result.aborted ? 'aborted' : (result.text !== null ? 'success' : 'error'),
          result: result.text,
          usage: result.usage,
          cumulativeUsage: result.cumulativeUsage,
        };

        const { encrypted, nonce } = encryptPayload(
          resultPayload,
          opts.secretKey,
          senderKey,
        );
        const resultEnvelope = createEnvelope(
          opts.name,
          envelope.from,
          'result',
          encrypted,
          nonce,
        );
        ws?.send(JSON.stringify(resultEnvelope));
      } catch (err) {
        const errorPayload = {
          taskId: envelope.id,
          status: 'error',
          error: err instanceof Error ? err.message : 'Unknown error',
        };
        const { encrypted, nonce } = encryptPayload(
          errorPayload,
          opts.secretKey,
          senderKey,
        );
        const errEnvelope = createEnvelope(
          opts.name,
          envelope.from,
          'result',
          encrypted,
          nonce,
        );
        ws?.send(JSON.stringify(errEnvelope));
      }
    }

    if (envelope.type === 'status_request') {
      decryptPayload<StatusRequestPayload>(
        envelope.encryptedPayload,
        envelope.nonce,
        opts.secretKey,
        senderKey,
      );

      const statusResponse: Record<string, unknown> = {
        worker: opts.name,
      };

      const fields = ['git', 'cwd', 'system'];

      if (fields.includes('cwd')) {
        statusResponse.cwd = opts.cwd || process.cwd();
      }

      if (fields.includes('git')) {
        try {
          const cwd = opts.cwd || process.cwd();
          const branch = execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim();
          const status = execSync('git status --short', { cwd, encoding: 'utf-8' }).trim();
          const lastCommit = execSync('git log --oneline -1', { cwd, encoding: 'utf-8' }).trim();
          statusResponse.git = { branch, status, lastCommit };
        } catch {
          statusResponse.git = { error: 'Not a git repository' };
        }
      }

      if (fields.includes('system')) {
        statusResponse.system = {
          platform: os.platform(),
          uptime: os.uptime(),
          memory: {
            used: os.totalmem() - os.freemem(),
            total: os.totalmem(),
          },
        };
      }

      // Always include usage and active tasks
      statusResponse.cumulativeUsage = getCumulativeUsage();
      const active = getActiveTasks();
      statusResponse.activeTasks = Array.from(active.entries()).map(
        ([id, desc]) => `${id}: ${desc}`
      );

      const { encrypted, nonce } = encryptPayload(
        statusResponse,
        opts.secretKey,
        senderKey,
      );
      const responseEnvelope = createEnvelope(
        opts.name,
        envelope.from,
        'status_response',
        encrypted,
        nonce,
      );
      ws?.send(JSON.stringify(responseEnvelope));
    }

    if (envelope.type === 'cancel') {
      const payload = decryptPayload<{ taskId: string }>(
        envelope.encryptedPayload,
        envelope.nonce,
        opts.secretKey,
        senderKey,
      );
      cancelTask(payload.taskId);
    }
  } catch (err) {
    console.error('[worker] Error handling envelope:', err);
  }
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      const hb: HeartbeatMessage = { type: 'heartbeat', timestamp: Date.now() };
      ws.send(JSON.stringify(hb));
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export function disconnect(): void {
  shouldReconnect = false;
  stopHeartbeat();
  ws?.close();
}
