import { describe, expect, it, vi } from 'vitest';

import { UserWorkspaceGitCredentialClient, WorkspaceGitCredentialClient } from './git-credential-client';

const USER_TOKEN = 'user-access-token-for-tests';

describe('user-owned Git credentials', () => {
  it('selects the default GitHub credential using the forwarded user token', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          credentials: [
            { credential_id: '111', git_provider: 'gitLab', is_default_for_provider: true },
            { credential_id: '222', git_provider: 'gitHub', is_default_for_provider: false },
            { credential_id: '333', git_provider: 'gitHubOAuth', is_default_for_provider: true },
          ],
        }),
        { status: 200 }
      )
    );
    const client = new UserWorkspaceGitCredentialClient({
      workspaceHost: 'workspace.example.databricks.com',
      fetchImplementation: fetchMock,
    });

    await expect(client.preferredGitHubCredentialId(USER_TOKEN)).resolves.toBe(333);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://workspace.example.databricks.com/api/2.0/git-credentials');
    expect(options?.method).toBe('GET');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.headers).toEqual({ Authorization: `Bearer ${USER_TOKEN}`, Accept: 'application/json' });
  });

  it('uses a sole GitHub credential when none is marked default', async () => {
    const client = userClientWithCredentials([
      { credential_id: 444, git_provider: 'gitHub' },
      { credential_id: 555, git_provider: 'gitLab' },
    ]);
    await expect(client.preferredGitHubCredentialId(USER_TOKEN)).resolves.toBe(444);
  });

  it('does not guess among multiple GitHub credentials', async () => {
    const client = userClientWithCredentials([
      { credential_id: 444, git_provider: 'gitHub' },
      { credential_id: 555, git_provider: 'gitHub' },
    ]);
    await expect(client.preferredGitHubCredentialId(USER_TOKEN)).rejects.toMatchObject({
      code: 'git_credential_ambiguous',
    });
  });

  it('reports a missing user credential without creating one under the app identity', async () => {
    const client = userClientWithCredentials([]);
    await expect(client.preferredGitHubCredentialId(USER_TOKEN)).rejects.toMatchObject({
      code: 'git_credential_missing',
    });
  });

  it('reports when the app user token lacks Git credential access', async () => {
    const client = new UserWorkspaceGitCredentialClient({
      workspaceHost: 'workspace.example.databricks.com',
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 })),
    });
    await expect(client.preferredGitHubCredentialId(USER_TOKEN)).rejects.toMatchObject({
      code: 'git_credential_access_denied',
    });
  });
});

describe('app-owned Git credential lifecycle', () => {
  it('registers a private-repository token under the app identity and deletes it', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ credential_id: 123456789 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new WorkspaceGitCredentialClient({
      workspaceHost: 'workspace.example.databricks.com',
      tokenProvider: { getToken: vi.fn().mockResolvedValue('service-principal-token') },
      fetchImplementation: fetchMock,
    });
    const sessionId = '11111111-1111-4111-8111-111111111111';

    await expect(client.create('private-repo-token', sessionId)).resolves.toBe(123456789);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://workspace.example.databricks.com/api/2.0/git-credentials');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer service-principal-token'
    );
    const createBody = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof createBody !== 'string') throw new TypeError('expected JSON request body');
    expect(JSON.parse(createBody)).toMatchObject({
      git_provider: 'gitHub',
      git_username: 'x-access-token',
      name: `lineage-impact-${sessionId}`,
      personal_access_token: 'private-repo-token',
    });

    await expect(client.delete(123456789)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://workspace.example.databricks.com/api/2.0/git-credentials/123456789'
    );
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('DELETE');
  });
});

function userClientWithCredentials(credentials: object[]): UserWorkspaceGitCredentialClient {
  return new UserWorkspaceGitCredentialClient({
    workspaceHost: 'workspace.example.databricks.com',
    fetchImplementation: vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ credentials }), { status: 200 })),
  });
}
