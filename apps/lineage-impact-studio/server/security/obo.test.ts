import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import { requireOboRequest } from './obo';

function request(headers: Record<string, string>): Request {
  return { headers } as Request;
}

describe('requireOboRequest', () => {
  it('requires both forwarded identity and token', () => {
    expect(() => requireOboRequest(request({ 'x-forwarded-user': 'user-1' }))).toThrow('user authorization');
    expect(() => requireOboRequest(request({ 'x-forwarded-access-token': 't'.repeat(32) }))).toThrow(
      'user authorization'
    );
  });

  it('returns a safe viewer without exposing the token', () => {
    const accessToken = `header.${'t'.repeat(2048)}.signature`;
    expect(
      requireOboRequest(
        request({
          'x-forwarded-user': 'user-1',
          'x-forwarded-email': 'viewer@example.com',
          'x-forwarded-access-token': accessToken,
        })
      )
    ).toEqual({ subject: 'user-1', displayName: 'viewer@example.com' });
    expect(
      JSON.stringify(
        requireOboRequest(
          request({
            'x-forwarded-user': 'user-1',
            'x-forwarded-access-token': accessToken,
          })
        )
      )
    ).not.toContain(accessToken);
  });

  it('rejects an implausibly large forwarded token', () => {
    expect(() =>
      requireOboRequest(
        request({
          'x-forwarded-user': 'user-1',
          'x-forwarded-access-token': 't'.repeat(16 * 1024 + 1),
        })
      )
    ).toThrow('user authorization');
  });
});
