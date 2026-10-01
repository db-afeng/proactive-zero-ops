import { z } from 'zod';

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const ClientIdSchema = z.string().uuid();
const StateSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const CodeChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const CodeVerifierSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/u);
const TokenResponseSchema = z.object({
  access_token: z
    .string()
    .min(20)
    .max(16 * 1024),
  token_type: z.string().regex(/^Bearer$/iu),
  expires_in: z.number().int().positive().max(86_400),
  scope: z.string().max(2048),
});
const OmnigentIdentitySchema = z.object({ user_id: z.string().email().max(512) });

export class DatabricksFixOAuthError extends Error {
  override readonly name = 'DatabricksFixOAuthError';

  constructor(readonly code: 'invalid_configuration' | 'exchange_failed' | 'identity_mismatch' | 'denied') {
    super('Databricks authorization for manual fixes could not be completed.');
  }
}

/** A separate, public U2M client for Omnigent. The app never receives a refresh token. */
export class DatabricksFixOAuthClient {
  readonly #workspaceOrigin: string;
  readonly #clientId: string;
  readonly #redirectUri: string;
  readonly #fetch: FetchImplementation;

  constructor(options: {
    workspaceHost: string;
    clientId: string;
    redirectUri: string;
    fetchImplementation?: FetchImplementation;
  }) {
    this.#workspaceOrigin = httpsOrigin(options.workspaceHost);
    const clientId = ClientIdSchema.safeParse(options.clientId);
    if (!clientId.success) throw new DatabricksFixOAuthError('invalid_configuration');
    this.#clientId = clientId.data;
    let redirect: URL;
    try {
      redirect = new URL(options.redirectUri);
    } catch {
      throw new DatabricksFixOAuthError('invalid_configuration');
    }
    if (
      redirect.protocol !== 'https:' ||
      redirect.username ||
      redirect.password ||
      redirect.pathname !== '/api/databricks/oauth/callback' ||
      redirect.search ||
      redirect.hash
    ) {
      throw new DatabricksFixOAuthError('invalid_configuration');
    }
    this.#redirectUri = redirect.toString();
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  static fromEnvironment(fetchImplementation: FetchImplementation = fetch): DatabricksFixOAuthClient | null {
    const workspaceHost = process.env.DATABRICKS_HOST;
    const clientId = process.env.DATABRICKS_FIX_OAUTH_CLIENT_ID;
    const redirectUri = process.env.DATABRICKS_FIX_OAUTH_REDIRECT_URI;
    if (!workspaceHost || !clientId || !redirectUri) return null;
    return new DatabricksFixOAuthClient({ workspaceHost, clientId, redirectUri, fetchImplementation });
  }

  buildAuthorizeUrl(input: { state: string; codeChallenge: string }): string {
    if (!StateSchema.safeParse(input.state).success || !CodeChallengeSchema.safeParse(input.codeChallenge).success) {
      throw new DatabricksFixOAuthError('invalid_configuration');
    }
    const url = new URL(`${this.#workspaceOrigin}/oidc/v1/authorize`);
    url.searchParams.set('client_id', this.#clientId);
    url.searchParams.set('redirect_uri', this.#redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('scope', 'all-apis');
    return url.toString();
  }

  async exchangeCode(input: { code: string; codeVerifier: string }): Promise<{ accessToken: string; expiresAt: Date }> {
    if (
      input.code.length < 1 ||
      input.code.length > 1024 ||
      !CodeVerifierSchema.safeParse(input.codeVerifier).success
    ) {
      throw new DatabricksFixOAuthError('exchange_failed');
    }
    const response = await this.#request(`${this.#workspaceOrigin}/oidc/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: this.#clientId,
        grant_type: 'authorization_code',
        scope: 'all-apis',
        redirect_uri: this.#redirectUri,
        code_verifier: input.codeVerifier,
        code: input.code,
      }),
    });
    if (!response.ok) throw new DatabricksFixOAuthError('exchange_failed');
    const body = await safeJson(response);
    const parsed = TokenResponseSchema.safeParse(body);
    if (!parsed.success || !parsed.data.scope.split(/\s+/u).includes('all-apis')) {
      throw new DatabricksFixOAuthError('exchange_failed');
    }
    return {
      accessToken: parsed.data.access_token,
      expiresAt: new Date(Date.now() + parsed.data.expires_in * 1000),
    };
  }

  /** Proves both the Databricks identity and the Omnigent access needed by Fix. */
  async verifyOmnigentIdentity(accessToken: string, expectedEmail: string): Promise<void> {
    if (accessToken.length < 20 || accessToken.length > 16 * 1024 || !z.email().safeParse(expectedEmail).success) {
      throw new DatabricksFixOAuthError('identity_mismatch');
    }
    const response = await this.#request(`${this.#workspaceOrigin}/api/2.0/omnigent/v1/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!response.ok) throw new DatabricksFixOAuthError('denied');
    const parsed = OmnigentIdentitySchema.safeParse(await safeJson(response));
    if (!parsed.success || parsed.data.user_id.toLowerCase() !== expectedEmail.toLowerCase()) {
      throw new DatabricksFixOAuthError('identity_mismatch');
    }
  }

  async #request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      return await this.#fetch(url, { ...init, signal: controller.signal });
    } catch {
      throw new DatabricksFixOAuthError('denied');
    } finally {
      clearTimeout(timeout);
    }
  }
}

function httpsOrigin(host: string): string {
  let url: URL;
  try {
    url = new URL(host.includes('://') ? host : `https://${host}`);
  } catch {
    throw new DatabricksFixOAuthError('invalid_configuration');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new DatabricksFixOAuthError('invalid_configuration');
  }
  return url.origin;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new DatabricksFixOAuthError('exchange_failed');
  }
}
