import nacl from 'tweetnacl';

// Use Node.js Buffer instead of tweetnacl-util for ESM compatibility
function encodeBase64(arr: Uint8Array): string {
  return Buffer.from(arr).toString('base64');
}
function decodeBase64(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, 'base64'));
}
function decodeUTF8(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, 'utf-8'));
}
function encodeUTF8(arr: Uint8Array): string {
  return Buffer.from(arr).toString('utf-8');
}

export interface KeyPair {
  publicKey: string; // base64
  secretKey: string; // base64
}

/** Generate a new X25519 key pair */
export function generateKeyPair(): KeyPair {
  const kp = nacl.box.keyPair();
  return {
    publicKey: encodeBase64(kp.publicKey),
    secretKey: encodeBase64(kp.secretKey),
  };
}

/** Derive a shared key from our secret + their public key */
function deriveSharedKey(ourSecretKey: string, theirPublicKey: string): Uint8Array {
  return nacl.box.before(
    decodeBase64(theirPublicKey),
    decodeBase64(ourSecretKey),
  );
}

/** Encrypt a payload object for a recipient */
export function encryptPayload(
  payload: unknown,
  ourSecretKey: string,
  theirPublicKey: string,
): { encrypted: string; nonce: string } {
  const message = decodeUTF8(JSON.stringify(payload));
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const sharedKey = deriveSharedKey(ourSecretKey, theirPublicKey);
  const encrypted = nacl.box.after(message, nonce, sharedKey);
  if (!encrypted) {
    throw new Error('Encryption failed');
  }
  return {
    encrypted: encodeBase64(encrypted),
    nonce: encodeBase64(nonce),
  };
}

/** Decrypt a payload from a sender */
export function decryptPayload<T = unknown>(
  encrypted: string,
  nonce: string,
  ourSecretKey: string,
  theirPublicKey: string,
): T {
  const sharedKey = deriveSharedKey(ourSecretKey, theirPublicKey);
  const decrypted = nacl.box.open.after(
    decodeBase64(encrypted),
    decodeBase64(nonce),
    sharedKey,
  );
  if (!decrypted) {
    throw new Error('Decryption failed — invalid key or tampered message');
  }
  return JSON.parse(encodeUTF8(decrypted)) as T;
}

/** Encrypt with a symmetric key (for local storage) */
export function encryptSymmetric(
  data: string,
  key: Uint8Array,
): { encrypted: string; nonce: string } {
  const message = decodeUTF8(data);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const encrypted = nacl.secretbox(message, nonce, key);
  return {
    encrypted: encodeBase64(encrypted),
    nonce: encodeBase64(nonce),
  };
}

/** Decrypt with a symmetric key */
export function decryptSymmetric(
  encrypted: string,
  nonce: string,
  key: Uint8Array,
): string {
  const decrypted = nacl.secretbox.open(
    decodeBase64(encrypted),
    decodeBase64(nonce),
    key,
  );
  if (!decrypted) {
    throw new Error('Symmetric decryption failed');
  }
  return encodeUTF8(decrypted);
}
