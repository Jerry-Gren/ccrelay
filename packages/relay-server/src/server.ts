import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { Hono } from 'hono';
import {
  type AuthMessage,
  type Envelope,
  type HeartbeatMessage,
  type KeyExchangeRequest,
  type WireMessage,
  type WorkerInfo,
  verifyJWT,
  OFFLINE_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  MAX_MESSAGE_SIZE,
} from '@ccrelay/shared';
import {
  initDatabase,
  upsertWorker,
  setWorkerStatus,
  updateHeartbeat,
  getAllWorkers,
  getWorker,
  queueMessage,
  getQueuedMessages,
  markDelivered,
  markOfflineWorkers,
  cleanExpiredMessages,
  logAudit,
} from './db.js';

// --- Rate Limiting ---

class RateLimiter {
  private windows = new Map<string, number[]>();

  /** Returns true if the action is allowed, false if rate limit exceeded. */
  check(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }
    // Slide window: remove expired timestamps
    const cutoff = now - windowMs;
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }
    if (timestamps.length >= limit) {
      return false;
    }
    timestamps.push(now);
    return true;
  }

  /** Remove all entries for a given key prefix (used on disconnect). */
  cleanup(keyPrefix: string): void {
    for (const key of this.windows.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.windows.delete(key);
      }
    }
  }
}

const rateLimiter = new RateLimiter();

// Track connections per JWT subject: subject -> Set<clientId>
const connectionsPerSubject = new Map<string, Set<string>>();
// Track connections per IP: ip -> Set<clientId>
const connectionsPerIp = new Map<string, Set<string>>();

const RATE_LIMIT_ENVELOPE = 60;       // max envelope messages per minute per connection
const RATE_LIMIT_ALL_MESSAGES = 200;  // max all messages per minute per connection
const RATE_LIMIT_WINDOW_MS = 60_000;  // 1 minute
const MAX_CONNECTIONS_PER_SUBJECT = 10;
const MAX_CONNECTIONS_PER_IP = 20;    // pre-auth + authenticated combined
const MAX_TOTAL_CONNECTIONS = 500;    // absolute server-wide cap
const MAX_QUEUED_PER_RECIPIENT = 100; // max offline messages per worker
const RATE_LIMIT_CLOSE_CODE = 4029;
const HTTP_RATE_LIMIT = 60;           // max HTTP requests per minute per IP
const HTTP_RATE_LIMIT_WINDOW_MS = 60_000;

interface ConnectedClient {
  ws: WebSocket;
  id: string;
  name: string;
  role: 'worker' | 'master';
  authenticated: boolean;
  jwtSubject?: string;
  ip: string;
}

const clients = new Map<string, ConnectedClient>();
// Map worker name -> client id for routing
const workerNameToClient = new Map<string, string>();
const masterClients = new Set<string>();
// Public keys: name -> publicKey (for key exchange)
const publicKeys = new Map<string, string>();

let jwtSecret: string;

export function startServer(options: {
  port: number;
  host?: string;
  secret: string;
  dbPath?: string;
}): void {
  jwtSecret = options.secret;
  initDatabase(options.dbPath);

  const app = new Hono();

  // Health check
  app.get('/', (c) => c.json({ status: 'ok', service: 'ccrelay', version: '0.1.0' }));
  app.get('/health', (c) => c.json({ status: 'ok', workers: getAllWorkers().length }));

  // List workers (requires auth header)
  app.get('/workers', (c) => {
    const auth = c.req.header('Authorization');
    if (!auth?.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    try {
      verifyJWT(auth.slice(7), jwtSecret);
    } catch {
      return c.json({ error: 'Invalid token' }, 401);
    }
    return c.json({ workers: getAllWorkers() });
  });

  // Create HTTP server
  const httpServer = createServer(async (req, res) => {
    try {
      // HTTP rate limiting by IP
      const httpIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
        || req.socket.remoteAddress || 'unknown';
      if (!rateLimiter.check(`http:${httpIp}`, HTTP_RATE_LIMIT, HTTP_RATE_LIMIT_WINDOW_MS)) {
        res.writeHead(429, { 'Retry-After': '60' });
        res.end('Rate limit exceeded');
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const request = new Request(url.toString(), {
        method: req.method,
        headers: Object.fromEntries(
          Object.entries(req.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        ),
      });
      const response = await app.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      const body = await response.text();
      res.end(body);
    } catch (err) {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  });

  // WebSocket server
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_SIZE });

  wss.on('connection', (ws, req) => {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress || 'unknown';

    // Total connection cap
    if (clients.size >= MAX_TOTAL_CONNECTIONS) {
      ws.close(4029, 'Server at capacity');
      return;
    }

    // Per-IP connection limit (prevents pre-auth connection floods)
    const ipConns = connectionsPerIp.get(ip);
    if (ipConns && ipConns.size >= MAX_CONNECTIONS_PER_IP) {
      ws.close(4029, 'Too many connections from this IP');
      return;
    }

    const clientId = crypto.randomUUID();
    const client: ConnectedClient = {
      ws,
      id: clientId,
      name: '',
      role: 'worker',
      authenticated: false,
      ip,
    };
    clients.set(clientId, client);

    // Track IP
    if (!connectionsPerIp.has(ip)) {
      connectionsPerIp.set(ip, new Set());
    }
    connectionsPerIp.get(ip)!.add(clientId);

    // Auth timeout
    const authTimer = setTimeout(() => {
      if (!client.authenticated) {
        ws.close(4001, 'Authentication timeout');
        clients.delete(clientId);
      }
    }, 5000);

    ws.on('message', (data) => {
      let msg: WireMessage;
      try {
        msg = JSON.parse(data.toString()) as WireMessage;
      } catch {
        ws.close(4002, 'Invalid JSON');
        return;
      }

      if (!client.authenticated) {
        // Pre-auth: only allow one message (the auth message itself)
        if (!rateLimiter.check(`preauth:${clientId}`, 2, 10_000)) {
          ws.close(4029, 'Too many pre-auth messages');
          return;
        }
        handleAuth(client, msg, authTimer);
        return;
      }

      handleMessage(client, msg);
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (client.authenticated) {
        // Clean up subject connection tracking
        if (client.jwtSubject) {
          const subjectConns = connectionsPerSubject.get(client.jwtSubject);
          if (subjectConns) {
            subjectConns.delete(client.id);
            if (subjectConns.size === 0) {
              connectionsPerSubject.delete(client.jwtSubject);
            }
          }
        }

        if (client.role === 'worker') {
          setWorkerStatus(client.id, 'offline');
          workerNameToClient.delete(client.name);
          logAudit('worker_disconnected', client.name);
          // Notify masters
          broadcastToMasters({
            type: 'worker_disconnected',
            workerId: client.id,
          });
        } else {
          masterClients.delete(client.id);
          logAudit('master_disconnected', client.name);
        }
      }
      // Clean up rate limiter state for this client
      rateLimiter.cleanup(client.id);
      rateLimiter.cleanup(`all:${client.id}`);
      rateLimiter.cleanup(`envelope:${client.id}`);
      // Clean up IP tracking
      const ipSet = connectionsPerIp.get(client.ip);
      if (ipSet) {
        ipSet.delete(client.id);
        if (ipSet.size === 0) connectionsPerIp.delete(client.ip);
      }
      clients.delete(clientId);
    });

    ws.on('error', (err) => {
      console.error(`[relay] WebSocket error for ${client.name || clientId}:`, err.message);
    });
  });

  // Periodic maintenance
  setInterval(() => {
    const offlined = markOfflineWorkers(OFFLINE_TIMEOUT_MS);
    for (const id of offlined) {
      const client = clients.get(id);
      if (client) {
        broadcastToMasters({
          type: 'worker_disconnected',
          workerId: id,
        });
      }
    }
    cleanExpiredMessages();
  }, HEARTBEAT_INTERVAL_MS);

  httpServer.listen(options.port, options.host || '0.0.0.0', () => {
    console.log(`[relay] Server listening on ${options.host || '0.0.0.0'}:${options.port}`);
  });
}

function handleAuth(client: ConnectedClient, msg: WireMessage, authTimer: NodeJS.Timeout): void {
  if (msg.type !== 'auth') {
    client.ws.close(4003, 'Expected auth message');
    return;
  }

  const authMsg = msg as AuthMessage;
  try {
    const payload = verifyJWT(authMsg.token, jwtSecret);
    const subject = (payload as unknown as Record<string, unknown>).sub as string || authMsg.name;

    // Check connection limit per JWT subject
    const existing = connectionsPerSubject.get(subject);
    if (existing && existing.size >= MAX_CONNECTIONS_PER_SUBJECT) {
      const errMsg = { type: 'error', error: `Connection limit exceeded (max ${MAX_CONNECTIONS_PER_SUBJECT} per subject)` };
      client.ws.send(JSON.stringify(errMsg));
      client.ws.close(RATE_LIMIT_CLOSE_CODE, 'Connection limit exceeded');
      return;
    }

    // Track connection for this subject
    if (!connectionsPerSubject.has(subject)) {
      connectionsPerSubject.set(subject, new Set());
    }
    connectionsPerSubject.get(subject)!.add(client.id);
    client.jwtSubject = subject;

    client.authenticated = true;
    client.name = authMsg.name;
    client.role = authMsg.role;
    clearTimeout(authTimer);

    // Store public key if provided
    if (authMsg.publicKey) {
      publicKeys.set(client.name, authMsg.publicKey);
    }

    if (client.role === 'worker') {
      const workerInfo: WorkerInfo & { publicKey?: string } = {
        id: client.id,
        name: client.name,
        status: 'online',
        lastHeartbeat: Date.now(),
        connectedAt: Date.now(),
        publicKey: authMsg.publicKey,
      };
      upsertWorker(workerInfo);
      workerNameToClient.set(client.name, client.id);
      logAudit('worker_connected', client.name);

      // Deliver queued messages
      const queued = getQueuedMessages(client.name);
      for (const envelope of queued) {
        client.ws.send(JSON.stringify(envelope));
      }
      markDelivered(queued.map((e) => e.id));

      // Notify masters
      broadcastToMasters({
        type: 'worker_connected',
        worker: workerInfo,
      });
    } else {
      masterClients.add(client.id);
      logAudit('master_connected', client.name);
    }

    const response = { type: 'auth_response' as const, success: true };
    client.ws.send(JSON.stringify(response));
    console.log(`[relay] ${client.role} '${client.name}' authenticated`);
  } catch (err) {
    const response = {
      type: 'auth_response' as const,
      success: false,
      error: err instanceof Error ? err.message : 'Auth failed',
    };
    client.ws.send(JSON.stringify(response));
    client.ws.close(4004, 'Authentication failed');
  }
}

function handleMessage(client: ConnectedClient, msg: WireMessage): void {
  // Rate limit: all messages (including heartbeats)
  if (!rateLimiter.check(`all:${client.id}`, RATE_LIMIT_ALL_MESSAGES, RATE_LIMIT_WINDOW_MS)) {
    const errMsg = { type: 'error', error: 'Rate limit exceeded (too many messages)' };
    client.ws.send(JSON.stringify(errMsg));
    client.ws.close(RATE_LIMIT_CLOSE_CODE, 'Rate limit exceeded');
    return;
  }

  if (msg.type === 'heartbeat') {
    updateHeartbeat(client.id);
    return;
  }

  // Handle envelope messages
  if ('encryptedPayload' in msg) {
    // Rate limit: envelope messages only
    if (!rateLimiter.check(`envelope:${client.id}`, RATE_LIMIT_ENVELOPE, RATE_LIMIT_WINDOW_MS)) {
      const errMsg = { type: 'error', error: 'Rate limit exceeded (too many envelope messages)' };
      client.ws.send(JSON.stringify(errMsg));
      client.ws.close(RATE_LIMIT_CLOSE_CODE, 'Rate limit exceeded');
      return;
    }
    const envelope = msg as Envelope;

    // Prevent sender spoofing: envelope.from must match the authenticated client name
    if (envelope.from !== client.name) {
      const errMsg = { type: 'error', error: 'Sender mismatch: envelope.from must match your authenticated name' };
      client.ws.send(JSON.stringify(errMsg));
      return;
    }

    logAudit('message_relay', envelope.from, envelope.to, envelope.type);

    // Route to recipient
    const recipientClientId = workerNameToClient.get(envelope.to);
    if (recipientClientId) {
      const recipientClient = clients.get(recipientClientId);
      if (recipientClient?.ws.readyState === WebSocket.OPEN) {
        recipientClient.ws.send(JSON.stringify(envelope));
        return;
      }
    }

    // Check if recipient is a master
    for (const masterId of masterClients) {
      const masterClient = clients.get(masterId);
      if (masterClient && masterClient.name === envelope.to && masterClient.ws.readyState === WebSocket.OPEN) {
        masterClient.ws.send(JSON.stringify(envelope));
        return;
      }
    }

    // Queue for offline delivery (bounded)
    if (!queueMessage(envelope, MAX_QUEUED_PER_RECIPIENT)) {
      const errMsg = { type: 'error', error: `Message queue full for '${envelope.to}' (max ${MAX_QUEUED_PER_RECIPIENT})` };
      client.ws.send(JSON.stringify(errMsg));
    }
  }

  // Handle workers list request
  if (msg.type === 'workers_list') {
    client.ws.send(JSON.stringify({
      type: 'workers_list',
      workers: getAllWorkers(),
    }));
  }

  // Handle key exchange request
  if (msg.type === 'key_exchange') {
    const req = msg as KeyExchangeRequest;
    const keys: Record<string, string> = {};
    if (req.requestKeys && req.requestKeys.length > 0) {
      for (const name of req.requestKeys) {
        const key = publicKeys.get(name);
        if (key) keys[name] = key;
      }
    } else {
      // Return all known keys
      for (const [name, key] of publicKeys) {
        keys[name] = key;
      }
    }
    client.ws.send(JSON.stringify({
      type: 'key_exchange_response',
      keys,
    }));
  }
}

function broadcastToMasters(msg: WireMessage): void {
  const data = JSON.stringify(msg);
  for (const masterId of masterClients) {
    const master = clients.get(masterId);
    if (master?.ws.readyState === WebSocket.OPEN) {
      master.ws.send(data);
    }
  }
}
