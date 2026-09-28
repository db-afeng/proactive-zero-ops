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

/** Reject before AppKit's development-mode SP fallback can be reached. */
export function requireOboRequest(request: Request): OboViewer {
  const subject = singleHeader(request, 'x-forwarded-user');
  const accessToken = singleHeader(request, 'x-forwarded-access-token');
  const email = optionalSingleHeader(request, 'x-forwarded-email');
  if (subject === null || accessToken === null || accessToken.length < 20) {
    throw new OboAuthorizationError();
  }
  return { subject, displayName: email ?? subject };
}

function optionalSingleHeader(request: Request, name: string): string | null {
  const value = request.headers[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || hasControl(value)) {
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
