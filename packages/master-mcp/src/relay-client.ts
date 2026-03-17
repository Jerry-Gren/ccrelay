import WebSocket from 'ws';
import {
  type AuthMessage,
  type AuthResponse,
  type Envelope,
  type HeartbeatMessage,
  type KeyExchangeResponse,
  type StreamChunkPayload,
  type ResultPayload,
  type WorkerInfo,
  type WireMessage,
  HEARTBEAT_INTERVAL_MS,
  reconnectDelay,
  encryptPayload,
  decryptPayload,
  createEnvelope,
} from '@ccrelay/shared';
import { addProgress, completeTask, getTask } from './task-tracker.js';

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

  private knownKeys = new Map<string, string>();
  private workers = new Map<string, WorkerInfo>();
  // For sendAndWait (used by worker_status)
  private pendingResponses = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private onWorkerEvent: WorkerEventHandler | null = null;

  constructor(options: RelayClientOptions) {
    this.options = options;
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
          this.ws?.send(JSON.stringify({ type: 'key_exchange' }));
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
            console.error(`[master] Learned key for '${name}'`);
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

      // Handle envelopes: stream_chunk, result, status_response
      if ('encryptedPayload' in msg) {
        this.handleEnvelope(msg as Envelope);
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

  private handleEnvelope(envelope: Envelope): void {
    const workerKey = this.knownKeys.get(envelope.from);
    if (!workerKey) return;

    let payload: Record<string, unknown>;
    try {
      payload = decryptPayload<Record<string, unknown>>(
        envelope.encryptedPayload,
        envelope.nonce,
        this.options.secretKey,
        workerKey,
      );
    } catch {
      return;
    }

    // Stream chunk → add to task progress
    if (envelope.type === 'stream_chunk') {
      const taskId = payload['taskId'] as string;
      const chunk = payload['chunk'] as string;
      if (taskId && chunk) {
        addProgress(taskId, chunk);
      }
      return;
    }

    // Result → complete the task
    if (envelope.type === 'result') {
      const taskId = payload['taskId'] as string;
      if (taskId) {
        completeTask(taskId, {
          status: (payload['status'] as 'success' | 'error' | 'aborted') || 'error',
          result: payload['result'] as string | undefined,
          error: payload['error'] as string | undefined,
          usage: payload['usage'] as any,
          cumulativeUsage: payload['cumulativeUsage'] as any,
        });
      }
      return;
    }

    // Status response or other → resolve pending request
    const pending = this.pendingResponses.get(envelope.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingResponses.delete(envelope.id);
      pending.resolve(payload);
      return;
    }

    // Try matching by taskId for pending requests
    for (const [reqId, p] of this.pendingResponses) {
      if (payload['taskId'] === reqId || payload['worker'] === reqId) {
        clearTimeout(p.timer);
        this.pendingResponses.delete(reqId);
        p.resolve(payload);
        return;
      }
    }
  }

  private async ensureWorkerKey(workerName: string): Promise<string> {
    const existing = this.knownKeys.get(workerName);
    if (existing) return existing;

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
        reject(new Error(`Could not fetch key for '${workerName}'`));
      }, 5000);

      this.ws?.on('message', handler);
      this.ws?.send(JSON.stringify({ type: 'key_exchange', requestKeys: [workerName] }));
    });
  }

  /** Send encrypted command to a worker (fire-and-forget, tracked by task-tracker) */
  async fireCommand(workerName: string, payload: unknown): Promise<string> {
    const workerKey = await this.ensureWorkerKey(workerName);
    const { encrypted, nonce } = encryptPayload(payload, this.options.secretKey, workerKey);
    const envelope = createEnvelope(this.options.name, workerName, 'command', encrypted, nonce);
    this.ws?.send(JSON.stringify(envelope));
    return envelope.id;
  }

  /** Send and wait for a direct response (used for status_request) */
  async sendAndWait<T = unknown>(
    workerName: string,
    type: Envelope['type'],
    payload: unknown,
    timeoutMs: number = 15_000,
  ): Promise<T> {
    const workerKey = await this.ensureWorkerKey(workerName);
    const { encrypted, nonce } = encryptPayload(payload, this.options.secretKey, workerKey);
    const envelope = createEnvelope(this.options.name, workerName, type, encrypted, nonce);

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

  /** Send cancel to worker */
  async sendCancel(workerName: string, taskId: string): Promise<void> {
    const workerKey = await this.ensureWorkerKey(workerName);
    const { encrypted, nonce } = encryptPayload({ taskId }, this.options.secretKey, workerKey);
    const envelope = createEnvelope(this.options.name, workerName, 'cancel', encrypted, nonce);
    this.ws?.send(JSON.stringify(envelope));
  }

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
