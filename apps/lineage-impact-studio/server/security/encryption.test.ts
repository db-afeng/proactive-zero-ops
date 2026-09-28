import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { Aes256GcmCipher, InvalidCiphertextError, decodeBase64EncryptionKey } from './encryption';

describe('AES-256-GCM encrypted values', () => {
  it('round-trips with required context and never reuses an IV', () => {
    const cipher = new Aes256GcmCipher(randomBytes(32));
    const first = cipher.seal('github-token-sensitive', 'github-token:user-1');
    const second = cipher.seal('github-token-sensitive', 'github-token:user-1');

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toContain('github-token-sensitive');
    expect(cipher.openText(first, 'github-token:user-1')).toBe('github-token-sensitive');
  });

  it('fails authentication after tag tampering, with the plaintext absent from errors', () => {
    const cipher = new Aes256GcmCipher(randomBytes(32));
    const sealed = cipher.seal('do-not-echo-this', 'patch:session-1');
    const changedTag = `${sealed.tag.slice(0, -1)}${sealed.tag.endsWith('A') ? 'B' : 'A'}`;

    expect(() => cipher.openText({ ...sealed, tag: changedTag }, 'patch:session-1')).toThrow(InvalidCiphertextError);
    try {
      cipher.openText({ ...sealed, tag: changedTag }, 'patch:session-1');
    } catch (error) {
      expect((error as Error).message).not.toContain('do-not-echo-this');
      expect((error as Error).message).not.toContain(sealed.tag);
    }
  });

  it('binds ciphertext to its record context and key', () => {
    const cipher = new Aes256GcmCipher(randomBytes(32));
    const other = new Aes256GcmCipher(randomBytes(32));
    const sealed = cipher.seal('patch', 'patch:session-1');
    expect(() => cipher.open(sealed, 'patch:session-2')).toThrow(InvalidCiphertextError);
    expect(() => other.open(sealed, 'patch:session-1')).toThrow(InvalidCiphertextError);
  });

  it('requires a canonical supplied 32-byte key', () => {
    const encoded = randomBytes(32).toString('base64');
    expect(decodeBase64EncryptionKey(encoded)).toHaveLength(32);
    expect(decodeBase64EncryptionKey(`${encoded}\n`)).toHaveLength(32);
    expect(decodeBase64EncryptionKey(`${encoded}\r\n`)).toHaveLength(32);
    expect(() => decodeBase64EncryptionKey(randomBytes(31).toString('base64'))).toThrow();
    expect(() => decodeBase64EncryptionKey(` ${encoded}`)).toThrow();
    expect(() => decodeBase64EncryptionKey(`${encoded} `)).toThrow();
    expect(() => decodeBase64EncryptionKey(`${encoded}\n\n`)).toThrow();
    expect(() => new Aes256GcmCipher(randomBytes(31))).toThrow();
  });
});
