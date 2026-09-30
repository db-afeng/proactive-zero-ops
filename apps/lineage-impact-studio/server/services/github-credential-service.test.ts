import { describe, expect, it, vi } from 'vitest';

import { GitHubIntegrationError } from '../integrations/github/errors';
import type { GitHubUserCredential } from '../persistence/repository';
import { GitHubCredentialService } from './github-credential-service';

const ACTOR = 'databricks-user-123';
const NOW = new Date('2026-09-30T00:00:00.000Z');

function credential(overrides: Partial<GitHubUserCredential> = {}): GitHubUserCredential {
  return {
    accessToken: 'ghu_expiring_access_token',
    refreshToken: 'ghr_rotating_refresh_token',
    tokenType: 'bearer',
    scopes: [],
    expiresAt: '2026-09-29T00:00:00.000Z',
    refreshTokenExpiresAt: '2027-03-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('GitHubCredentialService', () => {
  it('refreshes an expired user token and persists the rotated credential', async () => {
    const existing = credential();
    const refreshed = credential({
      accessToken: 'ghu_refreshed_access_token',
      refreshToken: 'ghr_refreshed_refresh_token',
      expiresAt: '2026-09-30T08:00:00.000Z',
    });
    const repository = {
      loadGitHubCredential: vi.fn().mockResolvedValue(existing),
      updateGitHubCredential: vi.fn().mockResolvedValue(true),
    };
    const github = { refreshUserToken: vi.fn().mockResolvedValue(refreshed) };

    await expect(new GitHubCredentialService(repository, github).loadActive(ACTOR, NOW)).resolves.toEqual(refreshed);
    expect(github.refreshUserToken).toHaveBeenCalledWith({ refreshToken: existing.refreshToken, now: NOW });
    expect(repository.updateGitHubCredential).toHaveBeenCalledWith({
      actorSubject: ACTOR,
      credential: refreshed,
      now: NOW,
    });
  });

  it('reuses a still-valid access token without calling GitHub', async () => {
    const existing = credential({ expiresAt: '2026-09-30T01:00:00.000Z' });
    const repository = {
      loadGitHubCredential: vi.fn().mockResolvedValue(existing),
      updateGitHubCredential: vi.fn(),
    };
    const github = { refreshUserToken: vi.fn() };

    await expect(new GitHubCredentialService(repository, github).loadActive(ACTOR, NOW)).resolves.toEqual(existing);
    expect(github.refreshUserToken).not.toHaveBeenCalled();
    expect(repository.updateGitHubCredential).not.toHaveBeenCalled();
  });

  it('coalesces concurrent refreshes for the same Databricks identity', async () => {
    const existing = credential();
    const refreshed = credential({ accessToken: 'ghu_refreshed_access_token' });
    let resolveRefresh: (value: GitHubUserCredential) => void = () => undefined;
    const pending = new Promise<GitHubUserCredential>((resolve) => {
      resolveRefresh = resolve;
    });
    const repository = {
      loadGitHubCredential: vi.fn().mockResolvedValue(existing),
      updateGitHubCredential: vi.fn().mockResolvedValue(true),
    };
    const github = { refreshUserToken: vi.fn().mockReturnValue(pending) };
    const service = new GitHubCredentialService(repository, github);

    const first = service.loadActive(ACTOR, NOW);
    const second = service.loadActive(ACTOR, NOW);
    await vi.waitFor(() => expect(github.refreshUserToken).toHaveBeenCalledTimes(1));
    resolveRefresh(refreshed);

    await expect(Promise.all([first, second])).resolves.toEqual([refreshed, refreshed]);
    expect(repository.updateGitHubCredential).toHaveBeenCalledTimes(1);
  });

  it('requires reconnection when no usable refresh token remains', async () => {
    const repository = {
      loadGitHubCredential: vi.fn().mockResolvedValue(credential({ refreshToken: null })),
      updateGitHubCredential: vi.fn(),
    };
    const github = { refreshUserToken: vi.fn() };

    await expect(new GitHubCredentialService(repository, github).loadActive(ACTOR, NOW)).rejects.toMatchObject({
      code: 'unauthorized',
    } satisfies Partial<GitHubIntegrationError>);
    expect(github.refreshUserToken).not.toHaveBeenCalled();
  });
});
