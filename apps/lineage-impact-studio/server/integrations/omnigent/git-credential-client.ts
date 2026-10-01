import { z } from 'zod';

import { DatabricksServicePrincipalTokenProvider } from './client';
import { OmnigentIntegrationError } from './errors';

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const CredentialResponseSchema = z.object({
  credential_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

const ListedCredentialSchema = z.object({
  credential_id: z
    .union([z.number(), z.string().regex(/^\d{1,16}$/u)])
    .transform(Number)
    .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
  git_provider: z.string().min(1),
  is_default_for_provider: z.boolean().optional().default(false),
});

const CredentialsListSchema = z.object({
  credentials: z.array(ListedCredentialSchema).max(1000).optional().default([]),
});

/** Finds a credential belonging to the signed-in user; never reads or returns its token. */
export class UserWorkspaceGitCredentialClient {
  readonly #baseUrl: string;
  readonly #fetch: FetchImplementation;

  constructor(options: { workspaceHost: string; fetchImplementation?: FetchImplementation }) {
    this.#baseUrl = credentialsBaseUrl(options.workspaceHost);
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  static fromEnvironment(fetchImplementation: FetchImplementation = fetch): UserWorkspaceGitCredentialClient | null {
    const workspaceHost = process.env.DATABRICKS_HOST;
    return workspaceHost ? new UserWorkspaceGitCredentialClient({ workspaceHost, fetchImplementation }) : null;
  }

  async preferredGitHubCredentialId(userAccessToken: string): Promise<number> {
    if (userAccessToken.length < 20 || userAccessToken.length > 16 * 1024) {
      throw new OmnigentIntegrationError('unauthorized');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = await this.#fetch(this.#baseUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${userAccessToken}`, Accept: 'application/json' },
      });
    } catch {
      throw new OmnigentIntegrationError('request_failed', null, true);
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 401 || response.status === 403) {
      throw new OmnigentIntegrationError('git_credential_access_denied', response.status);
    }
    if (!response.ok) throw credentialError(response.status);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new OmnigentIntegrationError('git_credential_unavailable');
    }
    const parsed = CredentialsListSchema.safeParse(body);
    if (!parsed.success) throw new OmnigentIntegrationError('git_credential_unavailable');
    const github = parsed.data.credentials.filter((item) =>
      ['github', 'githuboauth'].includes(item.git_provider.toLowerCase())
    );
    if (github.length === 0) throw new OmnigentIntegrationError('git_credential_missing');
    const defaults = github.filter((item) => item.is_default_for_provider);
    if (defaults.length === 1) return defaults[0].credential_id;
    if (defaults.length === 0 && github.length === 1) return github[0].credential_id;
    throw new OmnigentIntegrationError('git_credential_ambiguous');
  }
}

/** Git credentials used by app-owned managed sessions only. Never return a token to the browser. */
export class WorkspaceGitCredentialClient {
  readonly #baseUrl: string;
  readonly #tokenProvider: { getToken(): Promise<string> };
  readonly #fetch: FetchImplementation;

  constructor(options: {
    workspaceHost: string;
    tokenProvider: { getToken(): Promise<string> };
    fetchImplementation?: FetchImplementation;
  }) {
    this.#baseUrl = credentialsBaseUrl(options.workspaceHost);
    this.#tokenProvider = options.tokenProvider;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  static fromEnvironment(fetchImplementation: FetchImplementation = fetch): WorkspaceGitCredentialClient | null {
    const workspaceHost = process.env.DATABRICKS_HOST;
    const clientId = process.env.DATABRICKS_CLIENT_ID;
    const clientSecret = process.env.DATABRICKS_CLIENT_SECRET;
    if (!workspaceHost || !clientId || !clientSecret) return null;
    return new WorkspaceGitCredentialClient({
      workspaceHost,
      tokenProvider: new DatabricksServicePrincipalTokenProvider({
        workspaceHost,
        clientId,
        clientSecret,
        fetchImplementation,
      }),
      fetchImplementation,
    });
  }

  async create(accessToken: string, sessionId: string): Promise<number> {
    if (accessToken.length === 0 || accessToken.length > 4096 || !/^[0-9a-f-]{36}$/u.test(sessionId)) {
      throw new OmnigentIntegrationError('invalid_request');
    }
    const response = await this.#request('', {
      method: 'POST',
      body: JSON.stringify({
        git_provider: 'gitHub',
        git_username: 'x-access-token',
        name: `lineage-impact-${sessionId}`,
        personal_access_token: accessToken,
      }),
    });
    if (!response.ok) throw credentialError(response.status);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new OmnigentIntegrationError('git_credential_unavailable');
    }
    const parsed = CredentialResponseSchema.safeParse(body);
    if (!parsed.success) throw new OmnigentIntegrationError('git_credential_unavailable');
    return parsed.data.credential_id;
  }

  async delete(credentialId: number): Promise<void> {
    if (!Number.isSafeInteger(credentialId) || credentialId <= 0) {
      throw new OmnigentIntegrationError('invalid_request');
    }
    const response = await this.#request(`/${String(credentialId)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw credentialError(response.status);
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const token = await this.#tokenProvider.getToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
      });
    } catch {
      throw new OmnigentIntegrationError('request_failed', null, true);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function credentialsBaseUrl(workspaceHost: string): string {
  const candidate = workspaceHost.includes('://') ? workspaceHost : `https://${workspaceHost}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new OmnigentIntegrationError('invalid_configuration');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new OmnigentIntegrationError('invalid_configuration');
  }
  return `${url.origin}/api/2.0/git-credentials`;
}

function credentialError(status: number): OmnigentIntegrationError {
  return new OmnigentIntegrationError('git_credential_unavailable', status, status === 429 || status >= 500);
}
