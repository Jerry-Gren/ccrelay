import { randomBytes } from 'crypto';
import type { Envelope, EnvelopeType } from './types.js';

// Protocol constants
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const OFFLINE_TIMEOUT_MS = 45_000;
export const AUTH_TIMEOUT_MS = 5_000;
export const DEFAULT_TTL_SECONDS = 300; // 5 minutes
export const MAX_MESSAGE_SIZE = 1_024 * 1_024; // 1MB
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/** Generate a unique message ID */
export function generateId(): string {
  return randomBytes(16).toString('hex');
}

/** Create an envelope */
export function createEnvelope(
  from: string,
  to: string,
  type: EnvelopeType,
  encryptedPayload: string,
  nonce: string,
  ttl: number = DEFAULT_TTL_SECONDS,
): Envelope {
  return {
    id: generateId(),
    from,
    to,
    type,
    encryptedPayload,
    nonce,
    timestamp: Date.now(),
    ttl,
  };
}

/** Check if an envelope has expired */
export function isExpired(envelope: Envelope): boolean {
  return Date.now() > envelope.timestamp + envelope.ttl * 1000;
}

/** Calculate reconnect delay with exponential backoff + jitter */
export function reconnectDelay(attempt: number): number {
  const delay = Math.min(
    RECONNECT_BASE_MS * Math.pow(2, attempt),
    RECONNECT_MAX_MS,
  );
  // Add 0-25% jitter
  return delay + Math.random() * delay * 0.25;
}
