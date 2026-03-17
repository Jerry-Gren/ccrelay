import WebSocket from 'ws';
import {
  type AuthMessage,
  type AuthResponse,
  type Envelope,
  type HeartbeatMessage,
  type KeyExchangeResponse,
  type WorkerInfo,
  type WireMessage,
  HEARTBEAT_INTERVAL_MS,
  reconnectDelay,
  encryptPayload,
  decryptPayload,
  createEnvelope,
} from '@ccrelay/shared';

type MessageHandler = (envelope: Envelope) => void;
type WorkerEventHandler = (event: { type: 'connected' | 'disconnected'; worker: WorkerInfo | string }) => void;

interface RelayClientOptions {
  relayUrl: string;
  token: string;
  name: string;
  publicKey: string;
  secretKey: string;
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private shouldReconnect = true;
  private authenticated = false;
  private options: RelayClientOptions;

  // Known public keys (name -> public key) — auto-populated via key exchange
  private knownKeys = new Map<string, string>();
  // Cached worker list
  private workers = new Map<string, WorkerInfo>();
  // Pending responses: envelope ID -> resolve/reject
  private pendingResponses = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  // Event handlers
  private onMessage: MessageHandler | null = null;
  private onWorkerEvent: WorkerEventHandler | null = null;

  constructor(options: RelayClientOptions) {
    this.options = options;
  }

  setMessageHandler(handler: MessageHandler): void {
    this.onMessage = handler;
  }

  setWorkerEventHandler(handler: WorkerEventHandler): void {
    this.onWorkerEvent = handler;
  }

  registerWorkerKey(name: string, publicKey: string): void {
    this.knownKeys.set(name, publicKey);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.shouldReconnect = true;
      this.doConnect(resolve, reject);
    });
  }

  private doConnect(
    onFirstConnect?: (value: void) => void,
    onFirstError?: (reason: Error) => void,
  ): void {
    const opts = this.options;

    this.ws = new WebSocket(opts.relayUrl);

    this.ws.on('open', () => {
      const authMsg: AuthMessage = {
        type: 'auth',
        token: opts.token,
        role: 'master',
        name: opts.name,
        publicKey: opts.publicKey,
      };
      this.ws!.send(JSON.stringify(authMsg));
    });

    this.ws.on('message', (data) => {
      let msg: WireMessage;
      try {
        msg = JSON.parse(data.toString()) as WireMessage;
      } catch {
        return;
      }

      if (msg.type === 'auth_response') {
        const resp = msg as AuthResponse;
        if (resp.success) {
          this.authenticated = true;
          this.reconnectAttempt = 0;
          this.startHeartbeat();
          // Auto-fetch all known keys
          this.ws?.send(JSON.stringify({ type: 'key_exchange' }));
          // Also fetch workers list
          this.ws?.send(JSON.stringify({ type: 'workers_list' }));
          onFirstConnect?.();
          onFirstConnect = undefined;
        } else {
          this.shouldReconnect = false;
          onFirstError?.(new Error(resp.error || 'Auth failed'));
          onFirstError = undefined;
          this.ws?.close();
        }
        return;
      }

      if (msg.type === 'key_exchange_response') {
        const resp = msg as KeyExchangeResponse;
        for (const [name, key] of Object.entries(resp.keys)) {
          if (name !== opts.name) {
            this.knownKeys.set(name, key);
            console.error(`[master] Learned public key for '${name}'`);
          }
        }
        return;
      }

      if (msg.type === 'workers_list') {
        const list = (msg as { type: 'workers_list'; workers: WorkerInfo[] }).workers;
        this.workers.clear();
        for (const w of list) {
          this.workers.set(w.name, w);
        }
        return;
      }

      if (msg.type === 'worker_connected') {
        const w = (msg as { type: 'worker_connected'; worker: WorkerInfo }).worker;
        this.workers.set(w.name, w);
        // Fetch the new worker's key
        this.ws?.send(JSON.stringify({ type: 'key_exchange', requestKeys: [w.name] }));
        this.onWorkerEvent?.({ type: 'connected', worker: w });
        return;
      }

      if (msg.type === 'worker_disconnected') {
        const wId = (msg as { type: 'worker_disconnected'; workerId: string }).workerId;
        for (const [name, w] of this.workers) {
          if (w.id === wId) {
            this.workers.delete(name);
            this.onWorkerEvent?.({ type: 'disconnected', worker: wId });
            break;
          }
        }
        return;
      }

      // Handle envelope responses
      if ('encryptedPayload' in msg) {
        const envelope = msg as Envelope;
        this.handleEnvelopeResponse(envelope);
        this.onMessage?.(envelope);
      }
    });

    this.ws.on('close', () => {
      this.authenticated = false;
      this.stopHeartbeat();
      if (this.shouldReconnect) {
        const delay = reconnectDelay(this.reconnectAttempt++);
        setTimeout(() => this.doConnect(), delay);
      }
    });

    this.ws.on('error', (err) => {
      onFirstError?.(err as Error);
      onFirstError = undefined;
    });
  }

  private handleEnvelopeResponse(envelope: Envelope): void {
    const pending = this.pendingResponses.get(envelope.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingResponses.delete(envelope.id);

      try {
        const workerKey = this.knownKeys.get(envelope.from);
        if (!workerKey) {
          pending.reject(new Error(`No public key for worker '${envelope.from}'`));
          return;
        }
        const payload = decryptPayload(
          envelope.encryptedPayload,
          envelope.nonce,
          this.options.secretKey,
          workerKey,
        );
        pending.resolve(payload);
      } catch (err) {
        pending.reject(err instanceof Error ? err : new Error('Decryption failed'));
      }
      return;
    }

    // Match by decrypted taskId for results (envelope ID differs from request ID)
    for (const [reqId, p] of this.pendingResponses) {
      try {
        const workerKey = this.knownKeys.get(envelope.from);
        if (!workerKey) continue;
        const payload = decryptPayload<Record<string, unknown>>(
          envelope.encryptedPayload,
          envelope.nonce,
          this.options.secretKey,
          workerKey,
        );
        if (payload && payload['taskId'] === reqId) {
          clearTimeout(p.timer);
          this.pendingResponses.delete(reqId);
          p.resolve(payload);
          return;
        }
      } catch {
        // Decryption failed for this key, skip
      }
    }
  }

  /** Ensure we have a key for a worker, fetching from relay if needed */
  private async ensureWorkerKey(workerName: string): Promise<string> {
    const existing = this.knownKeys.get(workerName);
    if (existing) return existing;

    // Request key from relay
    return new Promise<string>((resolve, reject) => {
      const handler = (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'key_exchange_response' && msg.keys[workerName]) {
            this.knownKeys.set(workerName, msg.keys[workerName]);
            this.ws?.removeListener('message', handler);
            clearTimeout(timer);
            resolve(msg.keys[workerName]);
          }
        } catch { /* ignore */ }
      };

      const timer = setTimeout(() => {
        this.ws?.removeListener('message', handler);
        reject(new Error(`Could not fetch public key for '${workerName}'. Is the worker connected?`));
      }, 5000);

      this.ws?.on('message', handler);
      this.ws?.send(JSON.stringify({ type: 'key_exchange', requestKeys: [workerName] }));
    });
  }

  /** Send an encrypted envelope to a worker and wait for response */
  async sendAndWait<T = unknown>(
    workerName: string,
    type: Envelope['type'],
    payload: unknown,
    timeoutMs: number = 120_000,
  ): Promise<T> {
    const workerKey = await this.ensureWorkerKey(workerName);

    const { encrypted, nonce } = encryptPayload(
      payload,
      this.options.secretKey,
      workerKey,
    );

    const envelope = createEnvelope(
      this.options.name,
      workerName,
      type,
      encrypted,
      nonce,
    );

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(envelope.id);
        reject(new Error(`Timeout waiting for response from '${workerName}'`));
      }, timeoutMs);

      this.pendingResponses.set(envelope.id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.ws?.send(JSON.stringify(envelope));
    });
  }

  /** Send without waiting for response */
  async send(workerName: string, type: Envelope['type'], payload: unknown): Promise<string> {
    const workerKey = await this.ensureWorkerKey(workerName);

    const { encrypted, nonce } = encryptPayload(
      payload,
      this.options.secretKey,
      workerKey,
    );

    const envelope = createEnvelope(
      this.options.name,
      workerName,
      type,
      encrypted,
      nonce,
    );

    this.ws?.send(JSON.stringify(envelope));
    return envelope.id;
  }

  /** Request workers list from relay */
  requestWorkersList(): void {
    this.ws?.send(JSON.stringify({ type: 'workers_list' }));
  }

  getWorkers(): WorkerInfo[] {
    return Array.from(this.workers.values());
  }

  getWorker(name: string): WorkerInfo | undefined {
    return this.workers.get(name);
  }

  isConnected(): boolean {
    return this.authenticated && this.ws?.readyState === WebSocket.OPEN;
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    for (const [, p] of this.pendingResponses) {
      clearTimeout(p.timer);
      p.reject(new Error('Disconnected'));
    }
    this.pendingResponses.clear();
    this.ws?.close();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const hb: HeartbeatMessage = { type: 'heartbeat', timestamp: Date.now() };
        this.ws.send(JSON.stringify(hb));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
