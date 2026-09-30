import type { Request } from 'express';

export class OboAuthorizationError extends Error {
  override readonly name = 'OboAuthorizationError';

  constructor() {
    super('Databricks user authorization is required');
  }
}

export interface OboViewer {
  subject: string;
  displayName: string;
}

const MAX_IDENTITY_HEADER_LENGTH = 512;
const MAX_ACCESS_TOKEN_LENGTH = 16 * 1024;

/** Reject before AppKit's development-mode SP fallback can be reached. */
export function requireOboRequest(request: Request): OboViewer {
  const subject = singleHeader(request, 'x-forwarded-user');
  const accessToken = oboAccessToken(request);
  const email = optionalSingleHeader(request, 'x-forwarded-email');
  if (subject === null || accessToken === null || accessToken.length < 20) {
    throw new OboAuthorizationError();
  }
  return { subject, displayName: email ?? subject };
}

/** Server-only token access. Never include this value in response objects or logs. */
export function requireOboAccessToken(request: Request): string {
  const accessToken = oboAccessToken(request);
  if (accessToken === null) throw new OboAuthorizationError();
  return accessToken;
}

/** A verified gateway email used only to bind a separate OAuth grant to the same user. */
export function requireOboEmail(request: Request): string {
  const email = optionalSingleHeader(request, 'x-forwarded-email');
  if (email === null || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)) throw new OboAuthorizationError();
  return email;
}

/** Returns the forwarded token when present so callers may fall back to app auth. */
export function optionalOboAccessToken(request: Request): string | null {
  return oboAccessToken(request);
}

function optionalSingleHeader(request: Request, name: string): string | null {
  const value = request.headers[name];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTITY_HEADER_LENGTH ||
    hasControl(value)
  ) {
    return null;
  }
  return value;
}

function oboAccessToken(request: Request): string | null {
  const value = request.headers['x-forwarded-access-token'];
  if (typeof value !== 'string' || value.length < 20 || value.length > MAX_ACCESS_TOKEN_LENGTH || hasControl(value)) {
    return null;
  }
  return value;
}

function singleHeader(request: Request, name: string): string | null {
  return optionalSingleHeader(request, name);
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point <= 0x1f || point === 0x7f) return true;
  }
  return false;
}
