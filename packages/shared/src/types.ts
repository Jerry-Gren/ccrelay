// === Worker Types ===
export interface WorkerInfo {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'busy';
  lastHeartbeat: number;
  connectedAt: number;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

// === Envelope Types ===
export type EnvelopeType =
  | 'command'
  | 'result'
  | 'status_request'
  | 'status_response'
  | 'stream_chunk'
  | 'cancel'
  | 'error';

export interface Envelope {
  id: string;
  from: string;
  to: string;
  type: EnvelopeType;
  encryptedPayload: string; // base64 encoded
  nonce: string; // base64 encoded
  timestamp: number;
  ttl: number; // seconds
}

// === Decrypted Payload Types ===
export interface CommandPayload {
  prompt: string;
  options?: {
    model?: string;
    cwd?: string;
    timeout?: number;
  };
}

export interface ResultPayload {
  taskId: string;
  status: 'success' | 'error' | 'aborted';
  result?: string;
  error?: string;
  usage?: TokenUsage;
}

export interface StatusRequestPayload {
  fields?: ('git' | 'cwd' | 'tasks' | 'system')[];
}

export interface StatusResponsePayload {
  worker: string;
  cwd?: string;
  git?: {
    branch?: string;
    status?: string;
    lastCommit?: string;
  };
  activeTasks?: string[];
  system?: {
    platform?: string;
    uptime?: number;
    memory?: { used: number; total: number };
  };
}

export interface StreamChunkPayload {
  taskId: string;
  chunk: string;
  done: boolean;
}

export interface CancelPayload {
  taskId: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
  taskId?: string;
}

// === Token Usage ===
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
}

// === Auth ===
export interface AuthMessage {
  type: 'auth';
  token: string;
  role: 'worker' | 'master';
  name: string;
  publicKey?: string; // X25519 public key for E2E encryption
}

export interface AuthResponse {
  type: 'auth_response';
  success: boolean;
  error?: string;
}

// === Key Exchange ===
export interface KeyExchangeRequest {
  type: 'key_exchange';
  requestKeys?: string[]; // names to get keys for (empty = all)
}

export interface KeyExchangeResponse {
  type: 'key_exchange_response';
  keys: Record<string, string>; // name -> publicKey
}

// === Heartbeat ===
export interface HeartbeatMessage {
  type: 'heartbeat';
  timestamp: number;
}

// === Protocol Messages (what goes on the wire) ===
export type WireMessage =
  | AuthMessage
  | AuthResponse
  | HeartbeatMessage
  | Envelope
  | KeyExchangeRequest
  | KeyExchangeResponse
  | { type: 'workers_list'; workers: WorkerInfo[] }
  | { type: 'worker_connected'; worker: WorkerInfo }
  | { type: 'worker_disconnected'; workerId: string };

// === Task tracking ===
export interface Task {
  id: string;
  worker: string;
  prompt: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: string;
  error?: string;
  usage?: TokenUsage;
  createdAt: number;
  completedAt?: number;
}
