import { z } from 'zod';

import { DatabricksServicePrincipalTokenProvider } from './client';
import { OmnigentIntegrationError } from './errors';

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const CredentialResponseSchema = z.object({
  credential_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

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
    const candidate = options.workspaceHost.includes('://')
      ? options.workspaceHost
      : `https://${options.workspaceHost}`;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new OmnigentIntegrationError('invalid_configuration');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new OmnigentIntegrationError('invalid_configuration');
    }
    this.#baseUrl = `${url.origin}/api/2.0/git-credentials`;
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

function credentialError(status: number): OmnigentIntegrationError {
  return new OmnigentIntegrationError('git_credential_unavailable', status, status === 429 || status >= 500);
}
