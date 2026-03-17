import { createHmac } from 'crypto';

export interface JWTPayload {
  sub: string; // subject (worker name or 'master')
  role: 'worker' | 'master';
  iat: number; // issued at
  exp: number; // expiry
}

function base64url(str: string): string {
  return Buffer.from(str).toString('base64url');
}

function base64urlDecode(str: string): string {
  return Buffer.from(str, 'base64url').toString();
}

/** Sign a JWT */
export function signJWT(payload: JWTPayload, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

/** Verify and decode a JWT */
export function verifyJWT(token: string, secret: string): JWTPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const [header, body, signature] = parts;
  const expected = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  if (signature !== expected) {
    throw new Error('Invalid JWT signature');
  }
  const payload = JSON.parse(base64urlDecode(body)) as JWTPayload;
  if (payload.exp && Date.now() / 1000 > payload.exp) {
    throw new Error('JWT expired');
  }
  return payload;
}

/** Create a token for a worker or master */
export function createToken(
  name: string,
  role: 'worker' | 'master',
  secret: string,
  expiryHours: number = 24,
): string {
  const now = Math.floor(Date.now() / 1000);
  return signJWT(
    {
      sub: name,
      role,
      iat: now,
      exp: now + expiryHours * 3600,
    },
    secret,
  );
}
