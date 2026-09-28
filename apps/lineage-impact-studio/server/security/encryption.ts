import { createCipheriv, createDecipheriv, createSecretKey, randomBytes, type KeyObject } from 'node:crypto';

import { z } from 'zod';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 4 * 1024 * 1024;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export const SealedValueV1Schema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal('A256GCM'),
    iv: z.string().length(16).regex(BASE64URL_PATTERN),
    ciphertext: z.string().max(6_000_000).regex(BASE64URL_PATTERN),
    tag: z.string().length(22).regex(BASE64URL_PATTERN),
  })
  .strict();

export type SealedValueV1 = z.infer<typeof SealedValueV1Schema>;

export class InvalidCiphertextError extends Error {
  override readonly name = 'InvalidCiphertextError';

  constructor() {
    super('Encrypted value could not be authenticated');
  }
}

/** AES-256-GCM with required associated data and a fresh 96-bit IV per value. */
export class Aes256GcmCipher {
  readonly #key: KeyObject;

  constructor(keyMaterial: Uint8Array) {
    if (keyMaterial.byteLength !== 32) {
      throw new TypeError('Encryption key must contain exactly 32 bytes');
    }
    const copy = Buffer.from(keyMaterial);
    this.#key = createSecretKey(copy);
    copy.fill(0);
  }

  seal(plaintext: string | Uint8Array, associatedData: string): SealedValueV1 {
    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
    const aad = validateAssociatedData(associatedData);
    if (data.byteLength > MAX_PLAINTEXT_BYTES) {
      throw new RangeError('Value is too large to encrypt');
    }

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad, { plaintextLength: data.byteLength });
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      version: 1,
      algorithm: 'A256GCM',
      iv: iv.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: tag.toString('base64url'),
    };
  }

  open(value: unknown, associatedData: string): Buffer {
    try {
      const sealed = SealedValueV1Schema.parse(value);
      const aad = validateAssociatedData(associatedData);
      const iv = decodeCanonicalBase64Url(sealed.iv, IV_BYTES);
      const tag = decodeCanonicalBase64Url(sealed.tag, TAG_BYTES);
      const ciphertext = decodeCanonicalBase64Url(sealed.ciphertext);
      if (ciphertext.byteLength > MAX_PLAINTEXT_BYTES) {
        throw new InvalidCiphertextError();
      }

      const decipher = createDecipheriv(ALGORITHM, this.#key, iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aad, { plaintextLength: ciphertext.byteLength });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (error) {
      if (error instanceof TypeError && error.message.startsWith('Associated data')) {
        throw error;
      }
      throw new InvalidCiphertextError();
    }
  }

  openText(value: unknown, associatedData: string): string {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(this.open(value, associatedData));
    } catch (error) {
      if (error instanceof TypeError && error.message.startsWith('Associated data')) {
        throw error;
      }
      throw new InvalidCiphertextError();
    }
  }
}

export function decodeBase64EncryptionKey(value: string): Buffer {
  const normalized = value.endsWith('\r\n') ? value.slice(0, -2) : value.endsWith('\n') ? value.slice(0, -1) : value;
  if (!/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/.test(normalized)) {
    throw new TypeError('Encryption key is not a canonical base64-encoded 32-byte key');
  }
  const key = Buffer.from(normalized, 'base64');
  if (key.byteLength !== 32 || key.toString('base64') !== normalized) {
    key.fill(0);
    throw new TypeError('Encryption key is not a canonical base64-encoded 32-byte key');
  }
  return key;
}

function validateAssociatedData(value: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || hasControlCharacter(value)) {
    throw new TypeError('Associated data must be a short non-empty label');
  }
  return Buffer.from(value, 'utf8');
}

function decodeCanonicalBase64Url(value: string, expectedLength?: number): Buffer {
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.toString('base64url') !== value ||
    (expectedLength !== undefined && decoded.byteLength !== expectedLength)
  ) {
    throw new InvalidCiphertextError();
  }
  return decoded;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}
