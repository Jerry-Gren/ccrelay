import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { Envelope, WorkerInfo } from '@ccrelay/shared';

let db: Database.Database;

export function initDatabase(dbPath?: string): void {
  const resolvedPath = dbPath || path.join(process.cwd(), 'ccrelay.db');
  const dir = path.dirname(resolvedPath);
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema();
}

function createSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'offline',
      public_key TEXT,
      last_heartbeat INTEGER NOT NULL,
      connected_at INTEGER,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS message_queue (
      id TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      type TEXT NOT NULL,
      encrypted_payload TEXT NOT NULL,
      nonce TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      ttl INTEGER NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_mq_recipient ON message_queue(recipient, delivered, timestamp);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      sender TEXT,
      recipient TEXT,
      envelope_type TEXT,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);
  `);
}

// Worker operations
export function upsertWorker(worker: WorkerInfo & { publicKey?: string }): void {
  db.prepare(`
    INSERT INTO workers (id, name, status, public_key, last_heartbeat, connected_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      id = excluded.id,
      status = excluded.status,
      public_key = COALESCE(excluded.public_key, workers.public_key),
      last_heartbeat = excluded.last_heartbeat,
      connected_at = COALESCE(excluded.connected_at, workers.connected_at),
      metadata = excluded.metadata
  `).run(
    worker.id,
    worker.name,
    worker.status,
    worker.publicKey || null,
    worker.lastHeartbeat,
    worker.connectedAt,
    worker.metadata ? JSON.stringify(worker.metadata) : null,
  );
}

export function setWorkerStatus(id: string, status: WorkerInfo['status']): void {
  db.prepare('UPDATE workers SET status = ?, last_heartbeat = ? WHERE id = ?')
    .run(status, Date.now(), id);
}

export function updateHeartbeat(id: string): void {
  db.prepare('UPDATE workers SET last_heartbeat = ? WHERE id = ?')
    .run(Date.now(), id);
}

export function getWorker(name: string): (WorkerInfo & { publicKey?: string }) | undefined {
  const row = db.prepare('SELECT * FROM workers WHERE name = ?').get(name) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: row.id as string,
    name: row.name as string,
    status: row.status as WorkerInfo['status'],
    lastHeartbeat: row.last_heartbeat as number,
    connectedAt: row.connected_at as number,
    publicKey: row.public_key as string | undefined,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
  };
}

export function getAllWorkers(): WorkerInfo[] {
  const rows = db.prepare('SELECT * FROM workers ORDER BY name').all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    status: row.status as WorkerInfo['status'],
    lastHeartbeat: row.last_heartbeat as number,
    connectedAt: row.connected_at as number,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
  }));
}

export function markOfflineWorkers(timeoutMs: number): string[] {
  const cutoff = Date.now() - timeoutMs;
  const rows = db.prepare(
    'SELECT id FROM workers WHERE status != ? AND last_heartbeat < ?'
  ).all('offline', cutoff) as { id: string }[];

  if (rows.length > 0) {
    db.prepare(
      'UPDATE workers SET status = ? WHERE status != ? AND last_heartbeat < ?'
    ).run('offline', 'offline', cutoff);
  }
  return rows.map((r) => r.id);
}

// Message queue operations
export function getQueuedCount(recipient: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) as cnt FROM message_queue WHERE recipient = ? AND delivered = 0'
  ).get(recipient) as { cnt: number };
  return row.cnt;
}

export function queueMessage(envelope: Envelope, maxPerRecipient: number = 100): boolean {
  const count = getQueuedCount(envelope.to);
  if (count >= maxPerRecipient) {
    return false; // queue full
  }
  db.prepare(`
    INSERT INTO message_queue (id, sender, recipient, type, encrypted_payload, nonce, timestamp, ttl)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    envelope.id,
    envelope.from,
    envelope.to,
    envelope.type,
    envelope.encryptedPayload,
    envelope.nonce,
    envelope.timestamp,
    envelope.ttl,
  );
  return true;
}

export function getQueuedMessages(recipient: string): Envelope[] {
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM message_queue
    WHERE recipient = ? AND delivered = 0 AND (timestamp + ttl * 1000) > ?
    ORDER BY timestamp ASC
  `).all(recipient, now) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    from: row.sender as string,
    to: row.recipient as string,
    type: row.type as Envelope['type'],
    encryptedPayload: row.encrypted_payload as string,
    nonce: row.nonce as string,
    timestamp: row.timestamp as number,
    ttl: row.ttl as number,
  }));
}

export function markDelivered(ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE message_queue SET delivered = 1 WHERE id IN (${placeholders})`).run(...ids);
}

export function cleanExpiredMessages(): number {
  const result = db.prepare(
    'DELETE FROM message_queue WHERE (timestamp + ttl * 1000) < ?'
  ).run(Date.now());
  return result.changes;
}

// Audit log
export function logAudit(
  eventType: string,
  sender?: string,
  recipient?: string,
  envelopeType?: string,
): void {
  db.prepare(
    'INSERT INTO audit_log (event_type, sender, recipient, envelope_type, timestamp) VALUES (?, ?, ?, ?, ?)'
  ).run(eventType, sender || null, recipient || null, envelopeType || null, Date.now());
}

export function getDatabase(): Database.Database {
  return db;
}
