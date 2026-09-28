import type {
  AssessmentViewV1,
  AuditResponse,
  Capabilities,
  CommitOutcome,
  FixSession,
  GitHubConnection,
  ValidatedPatch,
} from './contracts';

interface ErrorPayload {
  code?: string;
  message?: string;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  const raw = await response.text();
  let payload: unknown;
  if (raw) {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      payload = undefined;
    }
  }

  if (!response.ok) {
    const error = isErrorPayload(payload) ? payload : undefined;
    throw new ApiRequestError(response.status, error?.message ?? 'The request could not be completed.', error?.code);
  }

  return payload as T;
}

function isErrorPayload(value: unknown): value is ErrorPayload {
  return typeof value === 'object' && value !== null;
}

function unwrapSession(value: FixSession | { session: FixSession }): FixSession {
  return 'session' in value ? value.session : value;
}

export function getAssessment(reference: string, signal?: AbortSignal) {
  return requestJson<AssessmentViewV1>(`/api/assessments/${encodeURIComponent(reference)}`, {
    cache: 'no-store',
    signal,
  });
}

export function getCapabilities(signal?: AbortSignal): Promise<Capabilities> {
  return requestJson<Capabilities>('/api/capabilities', { signal });
}

export function getGitHubStatus(signal?: AbortSignal): Promise<GitHubConnection> {
  return requestJson<GitHubConnection>('/api/github/status', { signal });
}

export function githubLoginUrl(returnTo: string) {
  return `/api/github/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export function disconnectGitHub(): Promise<GitHubConnection> {
  return requestJson<GitHubConnection>('/api/github/disconnect', { method: 'POST' });
}

export async function createFixSession(
  reference: string,
  guidance: string,
  expectedHeadSha: string
): Promise<FixSession> {
  const result = await requestJson<FixSession | { session: FixSession }>(
    `/api/assessments/${encodeURIComponent(reference)}/fix-sessions`,
    {
      method: 'POST',
      body: JSON.stringify({ guidance, expectedHeadSha }),
    }
  );
  return unwrapSession(result);
}

export async function getFixSession(id: string, signal?: AbortSignal): Promise<FixSession> {
  const result = await requestJson<FixSession | { session: FixSession }>(
    `/api/fix-sessions/${encodeURIComponent(id)}`,
    { signal }
  );
  return unwrapSession(result);
}

export async function cancelFixSession(id: string): Promise<FixSession> {
  const result = await requestJson<FixSession | { session: FixSession }>(
    `/api/fix-sessions/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  );
  return unwrapSession(result);
}

export function getValidatedPatch(id: string, signal?: AbortSignal) {
  return requestJson<ValidatedPatch>(`/api/fix-sessions/${encodeURIComponent(id)}/patch`, {
    signal,
  });
}

export function approvePatch(id: string, patchDigest: string, expectedHeadSha: string) {
  return requestJson<{ approvedAt?: string }>(`/api/fix-sessions/${encodeURIComponent(id)}/approval`, {
    method: 'POST',
    body: JSON.stringify({ patchDigest, expectedHeadSha }),
  });
}

export function commitPatch(id: string, patchDigest: string, expectedHeadSha: string): Promise<CommitOutcome> {
  return requestJson<CommitOutcome>(`/api/fix-sessions/${encodeURIComponent(id)}/commit`, {
    method: 'POST',
    body: JSON.stringify({ patchDigest, expectedHeadSha }),
  });
}

export function getAudit(reference: string, signal?: AbortSignal) {
  return requestJson<AuditResponse>(`/api/audit/${encodeURIComponent(reference)}`, { signal });
}
