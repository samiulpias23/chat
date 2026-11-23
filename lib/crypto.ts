// ==============================================================================
// CHATAF CLIENT-SIDE WEB CRYPTO ENGINE (ZERO-KNOWLEDGE ENVELOPE E2EE)
// Follows docs/plan.md v1.3.0 strict specification
// With automated pure-JS fallback for insecure contexts (e.g. mobile HTTP over LAN)
// ==============================================================================

import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { gcm } from '@noble/ciphers/aes.js';

// Base64 helpers
export function toBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// RFC4122 v4 UUID generator that works on all browsers and mobile devices
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {}
  }
  const bytes = getCrypto().getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant RFC4122
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// 8-character alphanumeric User ID helper (mix of numbers and letters)
export function toShortUserId(uuid: string | null | undefined): string {
  if (!uuid) return '—';
  const clean = uuid.replace(/-/g, '').trim();
  return clean.slice(0, 8).toUpperCase();
}

// ------------------------------------------------------------------------------
// Fallback Subtle Implementation for Insecure Contexts (plain HTTP on LAN IP)
// ------------------------------------------------------------------------------
class FallbackCryptoKey {
  type: string;
  algorithm: any;
  extractable: boolean;
  usages: string[];
  _rawBytes: Uint8Array;
  constructor(type: string, algorithm: any, extractable: boolean, usages: string[], rawBytes: Uint8Array) {
    this.type = type;
    this.algorithm = algorithm;
    this.extractable = extractable;
    this.usages = usages;
    this._rawBytes = rawBytes;
    (this as any)[Symbol.toStringTag] = 'CryptoKey';
  }
}

const fallbackSubtle = {
  async importKey(format: string, keyData: any, algorithm: any, extractable: boolean, keyUsages: string[]) {
    const raw = keyData instanceof Uint8Array ? keyData : new Uint8Array(keyData);
    return new FallbackCryptoKey('secret', typeof algorithm === 'string' ? { name: algorithm } : algorithm, extractable, keyUsages, raw);
  },

  async exportKey(format: string, key: any) {
    if (key._rawBytes) {
      return key._rawBytes.buffer.slice(key._rawBytes.byteOffset, key._rawBytes.byteOffset + key._rawBytes.byteLength);
    }
    throw new Error('Unsupported key in fallback');
  },

  async generateKey(algorithm: any, extractable: boolean, keyUsages: string[]) {
    const len = (algorithm.length || 256) / 8;
    const raw = getCrypto().getRandomValues(new Uint8Array(len));
    return new FallbackCryptoKey('secret', algorithm, extractable, keyUsages, raw);
  },

  async deriveBits(algorithm: any, baseKey: any, length: number) {
    if (algorithm.name === 'PBKDF2') {
      const salt = algorithm.salt instanceof Uint8Array ? algorithm.salt : new Uint8Array(algorithm.salt);
      const rawKey = baseKey._rawBytes || baseKey;
      const bytes = pbkdf2(sha256, rawKey, salt, { c: algorithm.iterations, dkLen: length / 8 });
      return bytes.buffer;
    }
    if (algorithm.name === 'HKDF') {
      const salt = algorithm.salt instanceof Uint8Array ? algorithm.salt : new Uint8Array(algorithm.salt);
      const info = algorithm.info instanceof Uint8Array ? algorithm.info : new Uint8Array(algorithm.info);
      const rawKey = baseKey._rawBytes || baseKey;
      const bytes = hkdf(sha256, rawKey, salt, info, length / 8);
      return bytes.buffer;
    }
    throw new Error(`Unsupported deriveBits algorithm: ${algorithm.name}`);
  },

  async deriveKey(algorithm: any, baseKey: any, derivedKeyType: any, extractable: boolean, keyUsages: string[]) {
    const len = (derivedKeyType.length || 256) / 8;
    const bits = await this.deriveBits(algorithm, baseKey, len * 8);
    return new FallbackCryptoKey('secret', derivedKeyType, extractable, keyUsages, new Uint8Array(bits));
  },

  async encrypt(algorithm: any, key: any, data: any) {
    const iv = algorithm.iv instanceof Uint8Array ? algorithm.iv : new Uint8Array(algorithm.iv);
    const aad = algorithm.additionalData ? (algorithm.additionalData instanceof Uint8Array ? algorithm.additionalData : new Uint8Array(algorithm.additionalData)) : undefined;
    const plaintext = data instanceof Uint8Array ? data : new Uint8Array(data);
    const rawKey = key._rawBytes || key;

    const cipher = gcm(rawKey, iv, aad);
    const ciphertext = cipher.encrypt(plaintext);
    return ciphertext.buffer;
  },

  async decrypt(algorithm: any, key: any, data: any) {
    const iv = algorithm.iv instanceof Uint8Array ? algorithm.iv : new Uint8Array(algorithm.iv);
    const aad = algorithm.additionalData ? (algorithm.additionalData instanceof Uint8Array ? algorithm.additionalData : new Uint8Array(algorithm.additionalData)) : undefined;
    const ciphertext = data instanceof Uint8Array ? data : new Uint8Array(data);
    const rawKey = key._rawBytes || key;

    const cipher = gcm(rawKey, iv, aad);
    const decrypted = cipher.decrypt(ciphertext);
    return decrypted.buffer;
  }
};

export function getCrypto(): Crypto {
  if (typeof window !== 'undefined' && window.crypto) {
    return window.crypto;
  }
  if (typeof globalThis !== 'undefined' && globalThis.crypto) {
    return globalThis.crypto;
  }
  return {
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      const bytes = new Uint8Array(array!.buffer, array!.byteOffset, array!.byteLength);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
      return array;
    }
  } as unknown as Crypto;
}

export function getSubtle(): SubtleCrypto {
  if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
    return window.crypto.subtle;
  }
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  return fallbackSubtle as unknown as SubtleCrypto;
}

// 1. Salt Generation (16 bytes)
export function generateSalt(): string {
  const salt = getCrypto().getRandomValues(new Uint8Array(16));
  return toBase64(salt);
}

// 2. Key Derivation from Password
// Single 600,000 PBKDF2-SHA256 -> HKDF splits into KEK and client_auth_token
export async function deriveKeysFromPassword(password: string, kdfSaltBase64: string): Promise<{
  kek: CryptoKey;
  authToken: string;
}> {
  const enc = new TextEncoder();
  const passwordBytes = enc.encode(password);
  const saltBytes = fromBase64(kdfSaltBase64);
  const subtle = getSubtle();

  // Import raw password for PBKDF2
  const baseKey = await subtle.importKey(
    'raw',
    passwordBytes,
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  // PBKDF2-SHA256 600,000 iterations
  const masterBits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes as unknown as BufferSource,
      iterations: 600000,
      hash: 'SHA-256',
    },
    baseKey,
    256 // 32 bytes
  );

  // Import master bits into HKDF
  const hkdfKey = await subtle.importKey(
    'raw',
    masterBits,
    { name: 'HKDF' },
    false,
    ['deriveKey', 'deriveBits']
  );

  // KEK (AES-GCM 256, wrap/unwrap only, non-extractable)
  const kek = await subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: enc.encode('chataf-kek'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']
  );

  // Client Auth Token (32 bytes derived bits -> base64)
  const authBits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: enc.encode('chataf-auth'),
    },
    hkdfKey,
    256
  );

  const authToken = toBase64(authBits);

  return { kek, authToken };
}

// 3. RMK Generation & Wrapping (Creation time only)
export async function createAndWrapRoomKey(kek: CryptoKey, roomId: string): Promise<{
  rmk: CryptoKey;
  wrappedKey: string;
  wrappedIv: string;
}> {
  const subtle = getSubtle();

  // Generate RMK (AES-GCM 256, extractable only to wrap)
  const rmk = await subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  const rawRmk = await subtle.exportKey('raw', rmk);

  // Wrap with KEK using fresh 12B IV and roomId as AAD
  const iv = getCrypto().getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(roomId);

  const encryptedRmk = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    kek,
    rawRmk
  );

  // Re-import RMK as non-extractable for memory safety
  const nonExtractableRmk = await subtle.importKey(
    'raw',
    rawRmk,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );

  return {
    rmk: nonExtractableRmk,
    wrappedKey: toBase64(encryptedRmk),
    wrappedIv: toBase64(iv),
  };
}

// 4. RMK Unwrapping (Unlock / Join time)
export async function unwrapRoomKey(
  kek: CryptoKey,
  wrappedKeyBase64: string,
  wrappedIvBase64: string,
  roomId: string
): Promise<CryptoKey> {
  const subtle = getSubtle();
  const ciphertext = fromBase64(wrappedKeyBase64);
  const iv = fromBase64(wrappedIvBase64);
  const aad = new TextEncoder().encode(roomId);

  const rawRmk = await subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: aad },
    kek,
    ciphertext as unknown as BufferSource
  );

  // Import as NON-EXTRACTABLE CryptoKey in memory
  return subtle.importKey(
    'raw',
    rawRmk,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function rotateRoomKeyWrapping(
  oldPassword: string,
  oldSalt: string,
  wrappedKeyBase64: string,
  wrappedIvBase64: string,
  roomId: string,
  newPassword: string,
  newSalt: string
): Promise<{
  newWrappedKey: string;
  newWrappedIv: string;
  newAuthToken: string;
  oldAuthToken: string;
}> {
  const subtle = getSubtle();
  const { kek: oldKek, authToken: oldAuthToken } = await deriveKeysFromPassword(oldPassword, oldSalt);
  const ciphertext = fromBase64(wrappedKeyBase64);
  const iv = fromBase64(wrappedIvBase64);
  const aad = new TextEncoder().encode(roomId);

  const rawRmk = await subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: aad },
    oldKek,
    ciphertext as unknown as BufferSource
  );

  const { kek: newKek, authToken: newAuthToken } = await deriveKeysFromPassword(newPassword, newSalt);
  const newIv = getCrypto().getRandomValues(new Uint8Array(12));
  const newEncryptedRmk = await subtle.encrypt(
    { name: 'AES-GCM', iv: newIv, additionalData: aad },
    newKek,
    rawRmk
  );

  return {
    newWrappedKey: toBase64(newEncryptedRmk),
    newWrappedIv: toBase64(newIv),
    newAuthToken,
    oldAuthToken,
  };
}

// 5. Message Content Encryption
export interface MessageContentPayload {
  text?: string;
  fileNames?: string[];
  gifUrl?: string;
  gifW?: number;
  gifH?: number;
  replyTo?: { id: string; name: string; text: string };
}

export async function encryptMessagePayload(
  rmk: CryptoKey,
  roomId: string,
  messageId: string,
  payload: MessageContentPayload
): Promise<{ encryptedContent: string; iv: string }> {
  const enc = new TextEncoder();
  const jsonStr = JSON.stringify(payload);
  const plaintextBytes = enc.encode(jsonStr);
  const subtle = getSubtle();

  const iv = getCrypto().getRandomValues(new Uint8Array(12));
  const aad = enc.encode(`${roomId}|${messageId}`);

  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    rmk,
    plaintextBytes
  );

  return {
    encryptedContent: toBase64(ciphertext),
    iv: toBase64(iv),
  };
}

export async function decryptMessagePayload(
  rmk: CryptoKey,
  roomId: string,
  messageId: string,
  encryptedContentBase64: string,
  ivBase64: string
): Promise<MessageContentPayload> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const ciphertext = fromBase64(encryptedContentBase64);
  const iv = fromBase64(ivBase64);
  const aad = enc.encode(`${roomId}|${messageId}`);
  const subtle = getSubtle();

  const decryptedBytes = await subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: aad },
    rmk,
    ciphertext as unknown as BufferSource
  );

  const jsonStr = dec.decode(decryptedBytes);
  return JSON.parse(jsonStr) as MessageContentPayload;
}

// 6. Binary Blob Media Encryption (Photos / Files)
// Format: iv(12B) || ciphertext+tag
export async function encryptMediaBlob(
  rmk: CryptoKey,
  roomId: string,
  messageId: string,
  slot: string, // e.g. 'thumb-0', 'raw-0'
  rawBytes: ArrayBuffer
): Promise<Blob> {
  const iv = getCrypto().getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(`${roomId}|${messageId}|${slot}`);
  const subtle = getSubtle();

  const encrypted = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    rmk,
    rawBytes
  );

  return new Blob([iv, encrypted], { type: 'application/octet-stream' });
}

export async function decryptMediaBlob(
  rmk: CryptoKey,
  roomId: string,
  messageId: string,
  slot: string,
  encryptedBlobBytes: ArrayBuffer
): Promise<ArrayBuffer> {
  if (encryptedBlobBytes.byteLength < 12) {
    throw new Error('Invalid encrypted media blob (too small).');
  }

  const iv = new Uint8Array(encryptedBlobBytes.slice(0, 12));
  const ciphertext = encryptedBlobBytes.slice(12);
  const aad = new TextEncoder().encode(`${roomId}|${messageId}|${slot}`);
  const subtle = getSubtle();

  return subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    rmk,
    ciphertext
  );
}
