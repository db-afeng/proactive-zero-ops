import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

const STATE_TTL_MIN_MS = 60_000;
const STATE_TTL_MAX_MS = 15 * 60_000;
const PKCE_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const OAuthAttemptRecordSchema = z
  .object({
    version: z.literal(1),
    stateDigest: z.string().regex(SHA256_PATTERN),
    bindingDigest: z.string().regex(SHA256_PATTERN),
    codeVerifier: z.string().regex(PKCE_PATTERN),
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    consumedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    const createdAt = Date.parse(record.createdAt);
    const expiresAt = Date.parse(record.expiresAt);
    const lifetime = expiresAt - createdAt;
    if (lifetime < STATE_TTL_MIN_MS || lifetime > STATE_TTL_MAX_MS) {
      context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Invalid state lifetime' });
    }
    if (record.consumedAt !== null) {
      const consumedAt = Date.parse(record.consumedAt);
      if (consumedAt < createdAt || consumedAt >= expiresAt) {
        context.addIssue({ code: 'custom', path: ['consumedAt'], message: 'Invalid consumption time' });
      }
    }
  });

export type OAuthAttemptRecord = z.infer<typeof OAuthAttemptRecordSchema>;

export interface IssuedOAuthAttempt {
  state: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  record: OAuthAttemptRecord;
}

export class OAuthStateError extends Error {
  override readonly name = 'OAuthStateError';

  constructor(readonly code: 'invalid' | 'expired' | 'replayed') {
    super('OAuth authorization attempt is not valid');
  }
}

export function issueOAuthAttempt(options: { binding: string; now?: Date; ttlMs?: number }): IssuedOAuthAttempt {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  validateDate(now);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < STATE_TTL_MIN_MS || ttlMs > STATE_TTL_MAX_MS) {
    throw new RangeError('OAuth state lifetime is outside the allowed range');
  }

  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + ttlMs);
  const record = OAuthAttemptRecordSchema.parse({
    version: 1,
    stateDigest: digest(state),
    bindingDigest: digest(validateBinding(options.binding)),
    codeVerifier,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    consumedAt: null,
  });

  return {
    state,
    codeChallenge: createPkceChallenge(codeVerifier),
    codeChallengeMethod: 'S256',
    record,
  };
}

export function consumeOAuthAttempt(options: {
  submittedState: string;
  binding: string;
  record: unknown;
  now?: Date;
}): { codeVerifier: string; consumedRecord: OAuthAttemptRecord } {
  const now = options.now ?? new Date();
  validateDate(now);

  if (!/^[A-Za-z0-9_-]{43}$/.test(options.submittedState)) {
    throw new OAuthStateError('invalid');
  }

  let record: OAuthAttemptRecord;
  try {
    record = OAuthAttemptRecordSchema.parse(options.record);
  } catch {
    throw new OAuthStateError('invalid');
  }

  if (record.consumedAt !== null) {
    throw new OAuthStateError('replayed');
  }
  if (now.getTime() >= Date.parse(record.expiresAt) || now.getTime() < Date.parse(record.createdAt)) {
    throw new OAuthStateError('expired');
  }

  const stateMatches = constantTimeHexEqual(digest(options.submittedState), record.stateDigest);
  const bindingMatches = constantTimeHexEqual(digest(validateBinding(options.binding)), record.bindingDigest);
  if (!stateMatches || !bindingMatches) {
    throw new OAuthStateError('invalid');
  }

  // The caller must persist consumedRecord with an atomic
  // "WHERE consumed_at IS NULL" update before exchanging the authorization
  // code. That compare-and-set is the cross-process replay boundary.
  return {
    codeVerifier: record.codeVerifier,
    consumedRecord: {
      ...record,
      consumedAt: now.toISOString(),
    },
  };
}

export function createPkceChallenge(codeVerifier: string): string {
  if (!PKCE_PATTERN.test(codeVerifier)) {
    throw new TypeError('Invalid PKCE verifier');
  }
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

export const OAUTH_COOKIE_OPTIONS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/api/github/oauth',
  maxAge: 15 * 60_000,
});

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function constantTimeHexEqual(left: string, right: string): boolean {
  const leftBytes = /^[0-9a-f]{64}$/.test(left) ? Buffer.from(left, 'hex') : Buffer.alloc(32);
  const rightValid = /^[0-9a-f]{64}$/.test(right);
  const rightBytes = rightValid ? Buffer.from(right, 'hex') : Buffer.alloc(32);
  return timingSafeEqual(leftBytes, rightBytes) && rightValid;
}

function validateBinding(value: string): string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 512) {
    throw new OAuthStateError('invalid');
  }
  return value;
}

function validateDate(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError('Invalid OAuth timestamp');
  }
}
