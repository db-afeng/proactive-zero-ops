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
    expect(
      requireOboRequest(
        request({
          'x-forwarded-user': 'user-1',
          'x-forwarded-email': 'viewer@example.com',
          'x-forwarded-access-token': 't'.repeat(32),
        })
      )
    ).toEqual({ subject: 'user-1', displayName: 'viewer@example.com' });
  });
});
