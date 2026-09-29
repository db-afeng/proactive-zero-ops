import { describe, expect, it, vi } from 'vitest';

import { validatePatchCandidate } from '../../security/patch-policy';
import { GitHubAppClient, PINNED_GITHUB_REPOSITORY } from './client';
import { GitHubIntegrationError } from './errors';

const CLIENT_ID = 'Iv1.1234567890abcdef';
const CLIENT_SECRET = 'github-client-secret-value';
const TOKEN = 'ghu_user_to_server_token';
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const OLD_BLOB_SHA = 'c'.repeat(40);
const BASE_TREE_SHA = 'd'.repeat(40);
const NEW_BLOB_SHA = 'e'.repeat(40);
const NEW_TREE_SHA = 'f'.repeat(40);
const COMMIT_SHA = '1'.repeat(40);
const PATH = 'src/lineage/check.py';

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function client(fetchImplementation: typeof fetch): GitHubAppClient {
  return new GitHubAppClient(
    {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: 'https://lineage-impact.example/api/github/oauth/callback',
    },
    fetchImplementation
  );
}

function pullResponse(overrides: Record<string, unknown> = {}) {
  return {
    number: 4,
    state: 'open',
    base: {
      sha: BASE_SHA,
      repo: { full_name: PINNED_GITHUB_REPOSITORY, fork: false },
    },
    head: {
      sha: HEAD_SHA,
      ref: 'feature/lineage-fix',
      repo: { full_name: PINNED_GITHUB_REPOSITORY, fork: false },
    },
    ...overrides,
  };
}

function repositoryResponse(canPush = true, canPull = true) {
  return { full_name: PINNED_GITHUB_REPOSITORY, permissions: { push: canPush, pull: canPull } };
}

function validatedPatch() {
  const patch = [
    `diff --git a/${PATH} b/${PATH}`,
    'index 1111111..2222222 100644',
    `--- a/${PATH}`,
    `+++ b/${PATH}`,
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');
  return validatePatchCandidate({
    gate: {
      baseRepository: PINNED_GITHUB_REPOSITORY,
      headRepository: PINNED_GITHUB_REPOSITORY,
      isFork: false,
      pullRequestState: 'open',
      canPush: true,
      force: false,
      commitStrategy: 'normal',
      expectedHeadSha: HEAD_SHA,
      observedHeadSha: HEAD_SHA,
    },
    files: [
      {
        beforePath: PATH,
        afterPath: PATH,
        binary: false,
        generated: false,
        beforeType: 'regular',
        afterType: 'regular',
      },
    ],
    patch,
  });
}

describe('GitHub App OAuth', () => {
  it('builds a pinned authorization URL with state and S256 PKCE', () => {
    const authorizeUrl = client(vi.fn()).buildAuthorizeUrl({
      state: 's'.repeat(43),
      codeChallenge: 'c'.repeat(43),
    });
    const parsed = new URL(authorizeUrl);
    expect(parsed.origin + parsed.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(parsed.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(parsed.searchParams.get('state')).toBe('s'.repeat(43));
    expect(parsed.searchParams.get('code_challenge')).toBe('c'.repeat(43));
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl).not.toContain(CLIENT_SECRET);
  });

  it('exchanges the code using PKCE and resolves the acting GitHub identity', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: TOKEN,
          token_type: 'bearer',
          scope: '',
          expires_in: 28_800,
          refresh_token: 'ghr_refresh_token',
          refresh_token_expires_in: 15_552_000,
        })
      )
      .mockResolvedValueOnce(jsonResponse({ id: 42, login: 'octocat', name: 'The Octocat' }));
    const github = client(fetchMock);
    const tokens = await github.exchangeCode({
      code: 'authorization_code',
      codeVerifier: 'v'.repeat(43),
      now: new Date('2026-09-28T00:00:00.000Z'),
    });
    const identity = await github.getViewer(tokens.accessToken);

    expect(tokens.accessToken).toBe(TOKEN);
    expect(tokens.expiresAt).toBe('2026-09-28T08:00:00.000Z');
    expect(identity).toEqual({ id: '42', login: 'octocat', displayName: 'The Octocat' });
    const exchangeBody = bodyText(fetchMock.mock.calls[0]?.[1]?.body);
    expect(exchangeBody).toContain('code_verifier=');
    expect(exchangeBody).toContain('client_secret=');
    const viewerHeaders = fetchMock.mock.calls[1]?.[1]?.headers;
    expect(JSON.stringify(viewerHeaders)).toContain(`Bearer ${TOKEN}`);
  });

  it('never puts OAuth secrets or token response contents in a typed failure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: 'bad_verification_code',
          error_description: `secret=${CLIENT_SECRET}&token=${TOKEN}`,
        },
        400
      )
    );
    const github = client(fetchMock);
    try {
      await github.exchangeCode({ code: 'bad_code', codeVerifier: 'v'.repeat(43) });
      throw new Error('expected exchange to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubIntegrationError);
      expect((error as GitHubIntegrationError).code).toBe('oauth_exchange_failed');
      expect((error as Error).message).not.toContain(CLIENT_SECRET);
      expect((error as Error).message).not.toContain(TOKEN);
      expect((error as Error).message).not.toContain('bad_verification_code');
    }
  });
});

describe('pull-request commit gate', () => {
  it('accepts a GitHub Actions installation token without a user-style push permission field', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(pullResponse()))
      .mockResolvedValueOnce(jsonResponse({ full_name: PINNED_GITHUB_REPOSITORY }));

    await expect(
      client(fetchMock).getValidatedPullRequest({
        accessToken: `ghs_${'a'.repeat(36)}`,
        pullRequestNumber: 4,
        expectedHeadSha: HEAD_SHA,
      })
    ).resolves.toMatchObject({ canPush: true, headSha: HEAD_SHA });
  });

  it('still rejects a user token without repository push permission', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(pullResponse()))
      .mockResolvedValueOnce(jsonResponse(repositoryResponse(false, true)));

    await expect(
      client(fetchMock).getValidatedPullRequest({
        accessToken: TOKEN,
        pullRequestNumber: 4,
        expectedHeadSha: HEAD_SHA,
      })
    ).rejects.toMatchObject({ code: 'write_not_permitted' });
  });

  it('binds changed paths to exact blobs at the assessed head', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sha: HEAD_SHA, tree: { sha: BASE_TREE_SHA } }))
      .mockResolvedValueOnce(
        jsonResponse({
          sha: BASE_TREE_SHA,
          truncated: false,
          tree: [{ path: PATH, mode: '100644', type: 'blob', sha: OLD_BLOB_SHA }],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ content: Buffer.from('old\n').toString('base64'), encoding: 'base64', size: 4 })
      );

    await expect(
      client(fetchMock).getExpectedFileVersions({
        accessToken: TOKEN,
        expectedHeadSha: HEAD_SHA,
        files: [
          { path: PATH, before: 'old\n' },
          { path: 'src/new.py', before: null },
        ],
      })
    ).resolves.toEqual([
      { path: PATH, expectedBlobSha: OLD_BLOB_SHA },
      { path: 'src/new.py', expectedBlobSha: null },
    ]);
  });

  it('rejects an Omnigent baseline that does not match the assessed GitHub blob', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sha: HEAD_SHA, tree: { sha: BASE_TREE_SHA } }))
      .mockResolvedValueOnce(
        jsonResponse({
          sha: BASE_TREE_SHA,
          truncated: false,
          tree: [{ path: PATH, mode: '100644', type: 'blob', sha: OLD_BLOB_SHA }],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ content: Buffer.from('actual\n').toString('base64'), encoding: 'base64', size: 7 })
      );

    await expect(
      client(fetchMock).getExpectedFileVersions({
        accessToken: TOKEN,
        expectedHeadSha: HEAD_SHA,
        files: [{ path: PATH, before: 'agent-claimed\n' }],
      })
    ).rejects.toMatchObject({ code: 'unsafe_change' });
  });

  it('rejects a fork even when the PR number and expected SHA look valid', async () => {
    const forkPull = pullResponse({
      head: {
        sha: HEAD_SHA,
        ref: 'feature/lineage-fix',
        repo: { full_name: 'attacker/proactive-zero-ops', fork: true },
      },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(forkPull))
      .mockResolvedValueOnce(jsonResponse(repositoryResponse()));
    await expect(
      client(fetchMock).getValidatedPullRequest({
        accessToken: TOKEN,
        pullRequestNumber: 4,
        expectedHeadSha: HEAD_SHA,
      })
    ).rejects.toMatchObject({ code: 'fork_not_supported' });
  });

  it('rejects changed heads before any Git write', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(pullResponse({ head: { ...pullResponse().head, sha: '9'.repeat(40) } })))
      .mockResolvedValueOnce(jsonResponse(repositoryResponse()));
    const patch = validatedPatch();
    await expect(
      client(fetchMock).createCommitFromValidatedPatch({
        accessToken: TOKEN,
        pullRequestNumber: 4,
        validatedPatch: patch,
        approvedExpectedHeadSha: HEAD_SHA,
        approvedPatchDigest: patch.digest,
        expectedFiles: [{ path: PATH, expectedBlobSha: OLD_BLOB_SHA }],
        message: 'Fix downstream lineage impact',
      })
    ).rejects.toMatchObject({ code: 'head_changed' });
    expect(fetchMock.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true);
  });

  it('derives text post-images from the approved patch and performs exactly one non-force commit', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const responses = [
      jsonResponse(pullResponse()),
      jsonResponse(repositoryResponse()),
      jsonResponse({ object: { sha: HEAD_SHA } }),
      jsonResponse({ sha: HEAD_SHA, tree: { sha: BASE_TREE_SHA } }),
      jsonResponse({
        sha: BASE_TREE_SHA,
        truncated: false,
        tree: [{ path: PATH, mode: '100644', type: 'blob', sha: OLD_BLOB_SHA }],
      }),
      jsonResponse({ content: Buffer.from('old\n').toString('base64'), encoding: 'base64', size: 4 }),
      jsonResponse({ sha: NEW_BLOB_SHA }),
      jsonResponse({ sha: NEW_TREE_SHA }),
      jsonResponse(pullResponse()),
      jsonResponse(repositoryResponse()),
      jsonResponse({ object: { sha: HEAD_SHA } }),
      jsonResponse({ sha: COMMIT_SHA, tree: { sha: NEW_TREE_SHA }, html_url: 'https://github.com/commit/1' }),
      jsonResponse({ object: { sha: HEAD_SHA } }),
      jsonResponse({ object: { sha: COMMIT_SHA } }),
    ];
    const fetchMock = vi.fn<typeof fetch>((url, init = {}) => {
      calls.push({ url: requestUrl(url), init });
      const response = responses.shift();
      if (response === undefined) return Promise.reject(new Error('unexpected fetch'));
      return Promise.resolve(response);
    });
    const patch = validatedPatch();
    const result = await client(fetchMock).createCommitFromValidatedPatch({
      accessToken: TOKEN,
      pullRequestNumber: 4,
      validatedPatch: patch,
      approvedExpectedHeadSha: HEAD_SHA,
      approvedPatchDigest: patch.digest,
      expectedFiles: [{ path: PATH, expectedBlobSha: OLD_BLOB_SHA }],
      message: 'Fix downstream lineage impact',
    });

    expect(result.commitSha).toBe(COMMIT_SHA);
    expect(responses).toHaveLength(0);
    const blobCreate = calls.find((call) => call.url.endsWith('/git/blobs') && call.init.method === 'POST');
    const blobBody = JSON.parse(bodyText(blobCreate?.init.body)) as { content: string; encoding: string };
    expect(Buffer.from(blobBody.content, 'base64').toString('utf8')).toBe('new\n');
    const commitCreates = calls.filter((call) => call.url.endsWith('/git/commits') && call.init.method === 'POST');
    expect(commitCreates).toHaveLength(1);
    expect(JSON.parse(bodyText(commitCreates[0]?.init.body))).toMatchObject({
      parents: [HEAD_SHA],
      tree: NEW_TREE_SHA,
    });
    const refUpdate = calls.find((call) => call.url.includes('/git/refs/heads/') && call.init.method === 'PATCH');
    expect(JSON.parse(bodyText(refUpdate?.init.body))).toEqual({ sha: COMMIT_SHA, force: false });
  });

  it('publishes an automatic proposal on a separate branch without updating the PR ref', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const branch = 'omnigent/pr-4/11111111';
    const responses = [
      jsonResponse(pullResponse()),
      jsonResponse(repositoryResponse()),
      jsonResponse({ object: { sha: HEAD_SHA } }),
      jsonResponse({ sha: HEAD_SHA, tree: { sha: BASE_TREE_SHA } }),
      jsonResponse({
        sha: BASE_TREE_SHA,
        truncated: false,
        tree: [{ path: PATH, mode: '100644', type: 'blob', sha: OLD_BLOB_SHA }],
      }),
      jsonResponse({ content: Buffer.from('old\n').toString('base64'), encoding: 'base64', size: 4 }),
      jsonResponse({ sha: NEW_BLOB_SHA }),
      jsonResponse({ sha: NEW_TREE_SHA }),
      jsonResponse(pullResponse()),
      jsonResponse(repositoryResponse()),
      jsonResponse({ object: { sha: HEAD_SHA } }),
      jsonResponse({ message: 'Not Found' }, 404),
      jsonResponse({
        sha: COMMIT_SHA,
        tree: { sha: NEW_TREE_SHA },
        parents: [{ sha: HEAD_SHA }],
        html_url: 'https://github.com/commit/1',
      }),
      jsonResponse({ object: { sha: COMMIT_SHA } }),
    ];
    const fetchMock = vi.fn<typeof fetch>((url, init = {}) => {
      calls.push({ url: requestUrl(url), init });
      const response = responses.shift();
      if (response === undefined) return Promise.reject(new Error('unexpected fetch'));
      return Promise.resolve(response);
    });
    const patch = validatedPatch();

    const result = await client(fetchMock).createProposalCommitFromValidatedPatch({
      accessToken: TOKEN,
      pullRequestNumber: 4,
      validatedPatch: patch,
      expectedHeadSha: HEAD_SHA,
      patchDigest: patch.digest,
      expectedFiles: [{ path: PATH, expectedBlobSha: OLD_BLOB_SHA }],
      branch,
      message: 'Propose downstream lineage fix',
    });

    expect(result).toMatchObject({ branch, commitSha: COMMIT_SHA, previousHeadSha: HEAD_SHA });
    expect(responses).toHaveLength(0);
    expect(calls.some((call) => call.init.method === 'PATCH')).toBe(false);
    const refCreate = calls.find((call) => call.url.endsWith('/git/refs') && call.init.method === 'POST');
    expect(JSON.parse(bodyText(refCreate?.init.body))).toEqual({
      ref: `refs/heads/${branch}`,
      sha: COMMIT_SHA,
    });
  });
});

describe('source-evidence read gate', () => {
  it('authorizes exact evidence only when the repository and both assessed SHAs still match', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(pullResponse()))
      .mockResolvedValueOnce(jsonResponse(repositoryResponse(false, true)));
    await expect(
      client(fetchMock).getValidatedSourcePullRequest({
        accessToken: TOKEN,
        repository: PINNED_GITHUB_REPOSITORY,
        pullRequestNumber: 4,
        expectedBaseSha: BASE_SHA,
        expectedHeadSha: HEAD_SHA,
      })
    ).resolves.toMatchObject({ canRead: true, baseSha: BASE_SHA, headSha: HEAD_SHA });
  });

  it.each([
    ['missing read access', pullResponse(), repositoryResponse(false, false), 'read_not_permitted'],
    [
      'stale base SHA',
      pullResponse({ base: { ...pullResponse().base, sha: '8'.repeat(40) } }),
      repositoryResponse(false, true),
      'base_changed',
    ],
    [
      'stale head SHA',
      pullResponse({ head: { ...pullResponse().head, sha: '9'.repeat(40) } }),
      repositoryResponse(false, true),
      'head_changed',
    ],
  ])('rejects %s', async (_label, pull, repository, code) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(pull))
      .mockResolvedValueOnce(jsonResponse(repository));
    await expect(
      client(fetchMock).getValidatedSourcePullRequest({
        accessToken: TOKEN,
        repository: PINNED_GITHUB_REPOSITORY,
        pullRequestNumber: 4,
        expectedBaseSha: BASE_SHA,
        expectedHeadSha: HEAD_SHA,
      })
    ).rejects.toMatchObject({ code });
  });
});

function bodyText(body: RequestInit['body']): string {
  if (typeof body !== 'string') throw new TypeError('expected string request body');
  return body;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}
