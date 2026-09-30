import { describe, expect, it, vi } from 'vitest';

import { WorkspaceGitCredentialClient } from './git-credential-client';

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
