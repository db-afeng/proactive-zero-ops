import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { OAUTH_COOKIE_OPTIONS, OAuthStateError, consumeOAuthAttempt, issueOAuthAttempt } from './oauth';

const BINDING = 'browser-cookie-binding-with-at-least-32-bytes';
const NOW = new Date('2026-09-28T10:00:00Z');

describe('GitHub OAuth state and PKCE', () => {
  it('issues short-lived state bound to the browser and an RFC 7636 S256 challenge', () => {
    const attempt = issueOAuthAttempt({ binding: BINDING, now: NOW, ttlMs: 5 * 60_000 });
    expect(attempt.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attempt.record.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attempt.codeChallenge).toBe(
      createHash('sha256').update(attempt.record.codeVerifier, 'ascii').digest('base64url')
    );
    expect(attempt.record).not.toHaveProperty('state');
    expect(OAUTH_COOKIE_OPTIONS).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax' });
  });

  it('consumes an attempt exactly once and returns the verifier for the token exchange', () => {
    const attempt = issueOAuthAttempt({ binding: BINDING, now: NOW });
    const consumed = consumeOAuthAttempt({
      submittedState: attempt.state,
      binding: BINDING,
      record: attempt.record,
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(consumed.codeVerifier).toBe(attempt.record.codeVerifier);
    expect(consumed.consumedRecord.consumedAt).not.toBeNull();

    expect(() =>
      consumeOAuthAttempt({
        submittedState: attempt.state,
        binding: BINDING,
        record: consumed.consumedRecord,
        now: new Date(NOW.getTime() + 2_000),
      })
    ).toThrow(expect.objectContaining({ code: 'replayed' }) as OAuthStateError);
  });

  it('rejects altered state, a different browser binding, and expiry', () => {
    const attempt = issueOAuthAttempt({ binding: BINDING, now: NOW, ttlMs: 60_000 });
    expect(() =>
      consumeOAuthAttempt({
        submittedState: `${attempt.state.slice(0, -1)}x`,
        binding: BINDING,
        record: attempt.record,
        now: new Date(NOW.getTime() + 1_000),
      })
    ).toThrow(OAuthStateError);
    expect(() =>
      consumeOAuthAttempt({
        submittedState: attempt.state,
        binding: 'different-browser-binding-at-least-32-bytes',
        record: attempt.record,
        now: new Date(NOW.getTime() + 1_000),
      })
    ).toThrow(OAuthStateError);
    expect(() =>
      consumeOAuthAttempt({
        submittedState: attempt.state,
        binding: BINDING,
        record: attempt.record,
        now: new Date(NOW.getTime() + 60_000),
      })
    ).toThrow(expect.objectContaining({ code: 'expired' }) as OAuthStateError);
  });

  it('rejects malformed state and a persisted lifetime outside the short-lived bound', () => {
    const attempt = issueOAuthAttempt({ binding: BINDING, now: NOW });
    expect(() =>
      consumeOAuthAttempt({
        submittedState: 'x'.repeat(10_000),
        binding: BINDING,
        record: attempt.record,
        now: new Date(NOW.getTime() + 1_000),
      })
    ).toThrow(OAuthStateError);
    expect(() =>
      consumeOAuthAttempt({
        submittedState: attempt.state,
        binding: BINDING,
        record: {
          ...attempt.record,
          expiresAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
        },
        now: new Date(NOW.getTime() + 1_000),
      })
    ).toThrow(OAuthStateError);
  });
});
