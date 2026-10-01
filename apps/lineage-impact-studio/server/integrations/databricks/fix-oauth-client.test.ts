import { describe, expect, it, vi } from 'vitest';

import { DatabricksFixOAuthClient, DatabricksFixOAuthError } from './fix-oauth-client';

const WORKSPACE_HOST = 'https://workspace.example.databricks.com';
const REDIRECT_URI = 'https://lineage.example.databricksapps.com/api/databricks/oauth/callback';
const CLIENT_ID = '2faa715f-25a4-4171-87ed-d286ba99cbb0';
const ACCESS_TOKEN = 'user-oauth-token-for-omnigent-123456789';

function client(fetchImplementation: typeof fetch = vi.fn()) {
  return new DatabricksFixOAuthClient({
    workspaceHost: WORKSPACE_HOST,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    fetchImplementation,
  });
}

describe('DatabricksFixOAuthClient', () => {
  it('requests only a short-lived all-apis authorization with PKCE and an exact callback', () => {
    const url = new URL(client().buildAuthorizeUrl({ state: 's'.repeat(43), codeChallenge: 'c'.repeat(43) }));
    expect(url.origin).toBe(WORKSPACE_HOST);
    expect(url.pathname).toBe('/oidc/v1/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      state: 's'.repeat(43),
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
      scope: 'all-apis',
    });
    expect(url.searchParams.get('scope')).not.toContain('offline_access');
  });

  it('exchanges the code, requires all-apis, and verifies that Omnigent sees the app user', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: ACCESS_TOKEN,
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'all-apis',
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_id: 'alex.feng@databricks.com' }), { status: 200 }));
    const oauth = client(fetchImplementation);
    const exchanged = await oauth.exchangeCode({ code: 'one-time-code', codeVerifier: 'v'.repeat(43) });
    expect(exchanged.accessToken).toBe(ACCESS_TOKEN);
    expect(exchanged.expiresAt.getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
    await oauth.verifyOmnigentIdentity(exchanged.accessToken, 'alex.feng@databricks.com');
    const tokenRequest = fetchImplementation.mock.calls[0];
    expect(tokenRequest?.[0]).toBe(`${WORKSPACE_HOST}/oidc/v1/token`);
    expect(tokenRequest?.[1]?.body).toBeInstanceOf(URLSearchParams);
    expect((tokenRequest?.[1]?.body as URLSearchParams).get('scope')).toBe('all-apis');
    const identityRequest = fetchImplementation.mock.calls[1];
    expect(identityRequest?.[0]).toBe(`${WORKSPACE_HOST}/api/2.0/omnigent/v1/me`);
    expect(identityRequest?.[1]?.headers).toMatchObject({ Authorization: `Bearer ${ACCESS_TOKEN}` });
  });

  it('rejects a different OAuth identity and an insufficient token scope', async () => {
    const wrongIdentity = client(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ user_id: 'other@databricks.com' }), { status: 200 }))
    );
    await expect(wrongIdentity.verifyOmnigentIdentity(ACCESS_TOKEN, 'alex.feng@databricks.com')).rejects.toMatchObject({
      code: 'identity_mismatch',
    } satisfies Partial<DatabricksFixOAuthError>);

    const wrongScope = client(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600, scope: 'sql' }),
            { status: 200 }
          )
        )
    );
    await expect(
      wrongScope.exchangeCode({ code: 'one-time-code', codeVerifier: 'v'.repeat(43) })
    ).rejects.toMatchObject({
      code: 'exchange_failed',
    } satisfies Partial<DatabricksFixOAuthError>);
  });
});
