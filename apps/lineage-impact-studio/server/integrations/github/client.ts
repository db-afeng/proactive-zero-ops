import { Buffer } from 'node:buffer';

import { z } from 'zod';

import { CommitShaSchema } from '../../domain/identifiers';
import {
  computePatchDigest,
  RepositoryPathSchema,
  validatePatchCandidate,
  verifyPatchApproval,
  type ChangedFileDescriptor,
  type ValidatedPatch,
} from '../../security/patch-policy';
import { GitHubIntegrationError } from './errors';

export const PINNED_GITHUB_REPOSITORY = 'db-afeng/proactive-zero-ops' as const;

const GITHUB_API_VERSION = '2022-11-28';
const API_BASE = 'https://api.github.com';
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CHANGED_FILES = 50;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BRANCH_SEGMENT_PATTERN = /^(?!\.\.?$)(?!.*\.lock$)[^~^:?*[\\]+$/u;

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GitHubAppOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GitHubOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  scopes: string[];
  expiresAt: string | null;
  refreshTokenExpiresAt: string | null;
}

export interface GitHubViewerIdentity {
  id: string;
  login: string;
  displayName: string | null;
}

export interface ValidatedPullRequest {
  number: number;
  repository: typeof PINNED_GITHUB_REPOSITORY;
  state: 'open';
  baseSha: string;
  headSha: string;
  headRef: string;
  canPush: true;
  isFork: false;
}

export interface ValidatedSourcePullRequest {
  number: number;
  repository: typeof PINNED_GITHUB_REPOSITORY;
  state: 'open';
  baseSha: string;
  headSha: string;
  canRead: true;
}

export interface ExpectedFileVersion {
  path: string;
  expectedBlobSha: string | null;
}

export interface CreatedCommit {
  repository: typeof PINNED_GITHUB_REPOSITORY;
  pullRequestNumber: number;
  previousHeadSha: string;
  commitSha: string;
  commitUrl: string | null;
}

export interface CreatedProposal extends CreatedCommit {
  branch: string;
}

const OAuthTokenResponseSchema = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096).optional(),
  token_type: z.string().min(1).max(64),
  scope: z.string().max(4096).optional().default(''),
  expires_in: z.number().int().positive().max(31_536_000).optional(),
  refresh_token_expires_in: z.number().int().positive().max(63_072_000).optional(),
});

const GitHubUserResponseSchema = z.object({
  id: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).transform(String),
  login: z.string().min(1).max(100),
  name: z.string().min(1).max(255).nullable().optional(),
});

const PullRequestResponseSchema = z.object({
  number: z.number().int().positive(),
  state: z.string(),
  base: z.object({
    sha: CommitShaSchema,
    repo: z.object({ full_name: z.string(), fork: z.boolean() }),
  }),
  head: z.object({
    sha: CommitShaSchema,
    ref: z.string(),
    repo: z.object({ full_name: z.string(), fork: z.boolean() }).nullable(),
  }),
});

const RepositoryResponseSchema = z.object({
  full_name: z.string(),
  permissions: z.object({ pull: z.boolean(), push: z.boolean() }).partial().optional(),
});

const GitReferenceResponseSchema = z.object({ object: z.object({ sha: CommitShaSchema }) });
const GitCommitResponseSchema = z.object({
  sha: CommitShaSchema,
  tree: z.object({ sha: CommitShaSchema }).optional(),
  parents: z.array(z.object({ sha: CommitShaSchema })).optional(),
  html_url: z.string().url().optional(),
});
const GitTreeResponseSchema = z.object({
  sha: CommitShaSchema,
  truncated: z.boolean().optional().default(false),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: CommitShaSchema,
    })
  ),
});
const GitBlobResponseSchema = z.object({
  content: z.string(),
  encoding: z.literal('base64'),
  size: z.number().int().nonnegative().max(MAX_FILE_BYTES),
});
const GitObjectShaResponseSchema = z.object({ sha: CommitShaSchema });

const ExpectedFileVersionSchema = z
  .object({
    path: z.string().min(1).max(4096),
    expectedBlobSha: CommitShaSchema.nullable(),
  })
  .strict();

interface ParsedPatchSection {
  path: string;
  beforePath: string | null;
  afterPath: string | null;
  hunks: ParsedHunk[];
}

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

export class GitHubAppClient {
  readonly #config: GitHubAppOAuthConfig;
  readonly #fetch: FetchImplementation;

  constructor(config: GitHubAppOAuthConfig, fetchImplementation: FetchImplementation = fetch) {
    this.#config = parseConfig(config);
    this.#fetch = fetchImplementation;
  }

  buildAuthorizeUrl(input: { state: string; codeChallenge: string }): string {
    if (!STATE_PATTERN.test(input.state) || !PKCE_CHALLENGE_PATTERN.test(input.codeChallenge)) {
      throw new GitHubIntegrationError('invalid_request');
    }
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', this.#config.clientId);
    url.searchParams.set('redirect_uri', this.#config.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async exchangeCode(input: { code: string; codeVerifier: string; now?: Date }): Promise<GitHubOAuthTokens> {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(input.code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) {
      throw new GitHubIntegrationError('invalid_request');
    }
    const now = validateDate(input.now ?? new Date());
    const body = new URLSearchParams({
      client_id: this.#config.clientId,
      client_secret: this.#config.clientSecret,
      code: input.code,
      redirect_uri: this.#config.redirectUri,
      code_verifier: input.codeVerifier,
    });
    let response: unknown;
    try {
      response = await this.requestJson(
        TOKEN_URL,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        },
        false
      );
    } catch (error) {
      if (error instanceof GitHubIntegrationError) {
        throw new GitHubIntegrationError('oauth_exchange_failed', error.retryable);
      }
      throw new GitHubIntegrationError('oauth_exchange_failed');
    }
    const parsed = OAuthTokenResponseSchema.safeParse(response);
    if (!parsed.success) throw new GitHubIntegrationError('oauth_exchange_failed');
    return mapOAuthTokens(parsed.data, now);
  }

  async refreshUserToken(input: { refreshToken: string; now?: Date }): Promise<GitHubOAuthTokens> {
    validateAccessToken(input.refreshToken);
    const now = validateDate(input.now ?? new Date());
    const body = new URLSearchParams({
      client_id: this.#config.clientId,
      client_secret: this.#config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
    });
    let response: unknown;
    try {
      response = await this.requestJson(
        TOKEN_URL,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        },
        false
      );
    } catch (error) {
      if (error instanceof GitHubIntegrationError) {
        throw new GitHubIntegrationError('oauth_exchange_failed', error.retryable);
      }
      throw new GitHubIntegrationError('oauth_exchange_failed');
    }
    const parsed = OAuthTokenResponseSchema.safeParse(response);
    if (!parsed.success) throw new GitHubIntegrationError('oauth_exchange_failed');
    return mapOAuthTokens(parsed.data, now);
  }

  async getViewer(accessToken: string): Promise<GitHubViewerIdentity> {
    const response = await this.apiJson('/user', accessToken, { method: 'GET' });
    const parsed = GitHubUserResponseSchema.safeParse(response);
    if (!parsed.success) throw new GitHubIntegrationError('invalid_response');
    return {
      id: parsed.data.id,
      login: parsed.data.login,
      displayName: parsed.data.name ?? null,
    };
  }

  /** Revokes the server-side token before its encrypted Lakebase row is deleted. */
  async revokeUserToken(accessToken: string): Promise<void> {
    validateAccessToken(accessToken);
    const authorization = Buffer.from(`${this.#config.clientId}:${this.#config.clientSecret}`, 'utf8').toString(
      'base64'
    );
    await this.requestNoContent(`${API_BASE}/applications/${encodeURIComponent(this.#config.clientId)}/token`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Basic ${authorization}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
  }

  async getValidatedPullRequest(input: {
    accessToken: string;
    pullRequestNumber: number;
    expectedHeadSha: string;
  }): Promise<ValidatedPullRequest> {
    const pullRequestNumberResult = z.number().int().positive().safeParse(input.pullRequestNumber);
    if (!pullRequestNumberResult.success) throw new GitHubIntegrationError('invalid_request');
    const pullRequestNumber = pullRequestNumberResult.data;
    const expectedHeadSha = parseRequestedCommitSha(input.expectedHeadSha);
    const [pullResponse, repositoryResponse] = await Promise.all([
      this.apiJson(`/repos/${PINNED_GITHUB_REPOSITORY}/pulls/${pullRequestNumber}`, input.accessToken, {
        method: 'GET',
      }),
      this.apiJson(`/repos/${PINNED_GITHUB_REPOSITORY}`, input.accessToken, { method: 'GET' }),
    ]);
    const pull = PullRequestResponseSchema.safeParse(pullResponse);
    const repository = RepositoryResponseSchema.safeParse(repositoryResponse);
    if (!pull.success || !repository.success) throw new GitHubIntegrationError('invalid_response');
    if (
      !sameRepository(pull.data.base.repo.full_name, PINNED_GITHUB_REPOSITORY) ||
      !sameRepository(repository.data.full_name, PINNED_GITHUB_REPOSITORY)
    ) {
      throw new GitHubIntegrationError('repository_mismatch');
    }
    if (
      pull.data.head.repo === null ||
      pull.data.head.repo.fork ||
      !sameRepository(pull.data.head.repo.full_name, PINNED_GITHUB_REPOSITORY)
    ) {
      throw new GitHubIntegrationError('fork_not_supported');
    }
    if (pull.data.state !== 'open') throw new GitHubIntegrationError('pull_request_closed');
    if (pull.data.head.sha !== expectedHeadSha) throw new GitHubIntegrationError('head_changed');
    if (repository.data.permissions?.push !== true) {
      throw new GitHubIntegrationError('write_not_permitted');
    }
    const headRef = validateBranchName(pull.data.head.ref);
    return {
      number: pull.data.number,
      repository: PINNED_GITHUB_REPOSITORY,
      state: 'open',
      baseSha: pull.data.base.sha,
      headSha: pull.data.head.sha,
      headRef,
      canPush: true,
      isFork: false,
    };
  }

  /** Authorize exact-expression disclosure without requiring repository write access. */
  async getValidatedSourcePullRequest(input: {
    accessToken: string;
    repository: string;
    pullRequestNumber: number;
    expectedBaseSha: string;
    expectedHeadSha: string;
  }): Promise<ValidatedSourcePullRequest> {
    validateAccessToken(input.accessToken);
    if (!sameRepository(input.repository, PINNED_GITHUB_REPOSITORY)) {
      throw new GitHubIntegrationError('repository_mismatch');
    }
    const pullRequestNumberResult = z.number().int().positive().safeParse(input.pullRequestNumber);
    if (!pullRequestNumberResult.success) throw new GitHubIntegrationError('invalid_request');
    const expectedBaseSha = parseRequestedCommitSha(input.expectedBaseSha);
    const expectedHeadSha = parseRequestedCommitSha(input.expectedHeadSha);
    const [pullResponse, repositoryResponse] = await Promise.all([
      this.apiJson(`/repos/${PINNED_GITHUB_REPOSITORY}/pulls/${pullRequestNumberResult.data}`, input.accessToken, {
        method: 'GET',
      }),
      this.apiJson(`/repos/${PINNED_GITHUB_REPOSITORY}`, input.accessToken, { method: 'GET' }),
    ]);
    const pull = PullRequestResponseSchema.safeParse(pullResponse);
    const repository = RepositoryResponseSchema.safeParse(repositoryResponse);
    if (!pull.success || !repository.success) throw new GitHubIntegrationError('invalid_response');
    if (
      !sameRepository(pull.data.base.repo.full_name, PINNED_GITHUB_REPOSITORY) ||
      !sameRepository(repository.data.full_name, PINNED_GITHUB_REPOSITORY)
    ) {
      throw new GitHubIntegrationError('repository_mismatch');
    }
    if (repository.data.permissions?.pull !== true) throw new GitHubIntegrationError('read_not_permitted');
    if (pull.data.state !== 'open') throw new GitHubIntegrationError('pull_request_closed');
    if (pull.data.base.sha !== expectedBaseSha) throw new GitHubIntegrationError('base_changed');
    if (pull.data.head.sha !== expectedHeadSha) throw new GitHubIntegrationError('head_changed');
    return {
      number: pull.data.number,
      repository: PINNED_GITHUB_REPOSITORY,
      state: 'open',
      baseSha: pull.data.base.sha,
      headSha: pull.data.head.sha,
      canRead: true,
    };
  }

  /** Capture the exact blob versions that approval and commit must revalidate. */
  async getExpectedFileVersions(input: {
    accessToken: string;
    expectedHeadSha: string;
    files: Array<{ path: string; before: string | null }>;
  }): Promise<ExpectedFileVersion[]> {
    validateAccessToken(input.accessToken);
    const expectedHeadSha = parseRequestedCommitSha(input.expectedHeadSha);
    const files = z
      .array(z.object({ path: RepositoryPathSchema, before: z.string().max(MAX_FILE_BYTES).nullable() }).strict())
      .min(1)
      .max(MAX_CHANGED_FILES)
      .parse(input.files);
    if (new Set(files.map((file) => file.path)).size !== files.length) {
      throw new GitHubIntegrationError('invalid_request');
    }
    const commitResponse = await this.apiJson(
      `/repos/${PINNED_GITHUB_REPOSITORY}/git/commits/${expectedHeadSha}`,
      input.accessToken,
      { method: 'GET' }
    );
    const commit = GitCommitResponseSchema.safeParse(commitResponse);
    if (!commit.success || commit.data.tree === undefined) throw new GitHubIntegrationError('invalid_response');
    const treeResponse = await this.apiJson(
      `/repos/${PINNED_GITHUB_REPOSITORY}/git/trees/${commit.data.tree.sha}?recursive=1`,
      input.accessToken,
      { method: 'GET' }
    );
    const tree = GitTreeResponseSchema.safeParse(treeResponse);
    if (!tree.success || tree.data.truncated) throw new GitHubIntegrationError('invalid_response');
    const entries = new Map(tree.data.tree.map((entry) => [entry.path, entry]));
    return await Promise.all(
      files.map(async (file) => {
        const entry = entries.get(file.path);
        if (entry === undefined) {
          if (file.before !== null) throw new GitHubIntegrationError('unsafe_change');
          return { path: file.path, expectedBlobSha: null };
        }
        if (file.before === null || entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
          throw new GitHubIntegrationError('unsafe_change');
        }
        const baseline = await this.loadTextBlob(input.accessToken, entry.sha);
        if (baseline.toString('utf8') !== file.before) throw new GitHubIntegrationError('unsafe_change');
        return { path: file.path, expectedBlobSha: entry.sha };
      })
    );
  }

  /**
   * Creates one non-force commit from a validated text patch. File post-images
   * are derived by applying that patch to blobs at the exact expected head;
   * callers cannot substitute unapproved contents.
   */
  async createCommitFromValidatedPatch(input: {
    accessToken: string;
    pullRequestNumber: number;
    validatedPatch: ValidatedPatch;
    approvedExpectedHeadSha: string;
    approvedPatchDigest: string;
    expectedFiles: ExpectedFileVersion[];
    message: string;
  }): Promise<CreatedCommit> {
    const message = validateCommitMessage(input.message);
    const prepared = await this.buildValidatedTree(input);
    const createdCommit = await this.createGitCommit({
      accessToken: input.accessToken,
      message,
      treeSha: prepared.treeSha,
      parentSha: prepared.expectedHeadSha,
    });

    await this.assertBranchHead(input.accessToken, prepared.pull.headRef, prepared.expectedHeadSha);
    const updateResponse = await this.apiJson(
      `/repos/${PINNED_GITHUB_REPOSITORY}/git/refs/heads/${encodeBranch(prepared.pull.headRef)}`,
      input.accessToken,
      {
        method: 'PATCH',
        body: JSON.stringify({ sha: createdCommit.data.sha, force: false }),
      }
    );
    const updatedRef = GitReferenceResponseSchema.safeParse(updateResponse);
    if (!updatedRef.success || updatedRef.data.object.sha !== createdCommit.data.sha) {
      throw new GitHubIntegrationError('invalid_response');
    }
    return {
      repository: PINNED_GITHUB_REPOSITORY,
      pullRequestNumber: prepared.pull.number,
      previousHeadSha: prepared.expectedHeadSha,
      commitSha: createdCommit.data.sha,
      commitUrl: createdCommit.data.html_url ?? null,
    };
  }

  /** Publishes a validated patch on an isolated branch without advancing the pull-request branch. */
  async createProposalCommitFromValidatedPatch(input: {
    accessToken: string;
    pullRequestNumber: number;
    validatedPatch: ValidatedPatch;
    expectedHeadSha: string;
    patchDigest: string;
    expectedFiles: ExpectedFileVersion[];
    branch: string;
    message: string;
  }): Promise<CreatedProposal> {
    const branch = validateBranchName(input.branch);
    const message = validateCommitMessage(input.message);
    const prepared = await this.buildValidatedTree({
      accessToken: input.accessToken,
      pullRequestNumber: input.pullRequestNumber,
      validatedPatch: input.validatedPatch,
      approvedExpectedHeadSha: input.expectedHeadSha,
      approvedPatchDigest: input.patchDigest,
      expectedFiles: input.expectedFiles,
    });
    if (branch === prepared.pull.headRef) throw new GitHubIntegrationError('invalid_request');

    const existing = await this.readBranchHead(input.accessToken, branch);
    if (existing !== null) {
      const commit = await this.validateProposalCommit(
        input.accessToken,
        existing,
        prepared.expectedHeadSha,
        prepared.treeSha
      );
      return proposalResult(prepared.pull.number, prepared.expectedHeadSha, branch, commit);
    }

    const created = await this.createGitCommit({
      accessToken: input.accessToken,
      message,
      treeSha: prepared.treeSha,
      parentSha: prepared.expectedHeadSha,
    });
    try {
      const refResponse = await this.apiJson(`/repos/${PINNED_GITHUB_REPOSITORY}/git/refs`, input.accessToken, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: created.data.sha }),
      });
      const ref = GitReferenceResponseSchema.safeParse(refResponse);
      if (!ref.success || ref.data.object.sha !== created.data.sha) {
        throw new GitHubIntegrationError('invalid_response');
      }
      return proposalResult(prepared.pull.number, prepared.expectedHeadSha, branch, created.data);
    } catch (error) {
      if (!(error instanceof GitHubIntegrationError && error.code === 'conflict')) throw error;
      const racedHead = await this.readBranchHead(input.accessToken, branch);
      if (racedHead === null) throw error;
      const reconciled = await this.validateProposalCommit(
        input.accessToken,
        racedHead,
        prepared.expectedHeadSha,
        prepared.treeSha
      );
      return proposalResult(prepared.pull.number, prepared.expectedHeadSha, branch, reconciled);
    }
  }

  private async buildValidatedTree(input: {
    accessToken: string;
    pullRequestNumber: number;
    validatedPatch: ValidatedPatch;
    approvedExpectedHeadSha: string;
    approvedPatchDigest: string;
    expectedFiles: ExpectedFileVersion[];
  }): Promise<{ pull: ValidatedPullRequest; expectedHeadSha: string; treeSha: string }> {
    validateAccessToken(input.accessToken);
    const approvedExpectedHeadSha = parseRequestedCommitSha(input.approvedExpectedHeadSha);
    const digestResult = z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .safeParse(input.approvedPatchDigest);
    if (!digestResult.success) throw new GitHubIntegrationError('invalid_request');
    let validatedPatch: ValidatedPatch;
    try {
      validatedPatch = validatePatchCandidate({
        gate: input.validatedPatch.gate,
        files: input.validatedPatch.files,
        patch: input.validatedPatch.bytes,
      });
    } catch {
      throw new GitHubIntegrationError('unsafe_change');
    }
    if (
      input.validatedPatch.digest !== computePatchDigest(input.validatedPatch.bytes) ||
      !verifyPatchApproval({
        patch: validatedPatch.bytes,
        requestedPatchDigest: validatedPatch.digest,
        approvedPatchDigest: digestResult.data,
        expectedHeadSha: validatedPatch.gate.expectedHeadSha,
        approvedHeadSha: approvedExpectedHeadSha,
      })
    ) {
      throw new GitHubIntegrationError('unsafe_change');
    }
    if (
      !sameRepository(validatedPatch.gate.baseRepository, PINNED_GITHUB_REPOSITORY) ||
      !sameRepository(validatedPatch.gate.headRepository, PINNED_GITHUB_REPOSITORY) ||
      validatedPatch.gate.isFork ||
      validatedPatch.gate.force ||
      validatedPatch.gate.commitStrategy !== 'normal'
    ) {
      throw new GitHubIntegrationError('repository_mismatch');
    }

    const expectedFiles = bindExpectedFiles(input.expectedFiles, validatedPatch.files);
    const sections = parsePatchSections(validatedPatch.bytes, validatedPatch.files);
    const initialPull = await this.getValidatedPullRequest({
      accessToken: input.accessToken,
      pullRequestNumber: input.pullRequestNumber,
      expectedHeadSha: approvedExpectedHeadSha,
    });
    await this.assertBranchHead(input.accessToken, initialPull.headRef, approvedExpectedHeadSha);
    const commitResponse = await this.apiJson(
      `/repos/${PINNED_GITHUB_REPOSITORY}/git/commits/${approvedExpectedHeadSha}`,
      input.accessToken,
      { method: 'GET' }
    );
    const baseCommit = GitCommitResponseSchema.safeParse(commitResponse);
    if (!baseCommit.success || baseCommit.data.tree === undefined) throw new GitHubIntegrationError('invalid_response');
    const treeResponse = await this.apiJson(
      `/repos/${PINNED_GITHUB_REPOSITORY}/git/trees/${baseCommit.data.tree.sha}?recursive=1`,
      input.accessToken,
      { method: 'GET' }
    );
    const baseTree = GitTreeResponseSchema.safeParse(treeResponse);
    if (!baseTree.success || baseTree.data.truncated) throw new GitHubIntegrationError('invalid_response');
    const treeEntries = new Map(baseTree.data.tree.map((entry) => [entry.path, entry]));
    compareExpectedTree(expectedFiles, treeEntries);

    const newTreeEntries: Array<{
      path: string;
      mode: '100644' | '100755';
      type: 'blob';
      sha: string | null;
    }> = [];
    let totalBytes = 0;
    for (const expectedFile of expectedFiles) {
      const section = sections.get(expectedFile.path);
      if (section === undefined) throw new GitHubIntegrationError('unsafe_change');
      const existingEntry = treeEntries.get(expectedFile.path);
      const before =
        expectedFile.expectedBlobSha === null
          ? Buffer.alloc(0)
          : await this.loadTextBlob(input.accessToken, expectedFile.expectedBlobSha);
      const after = applyPatchSection(before, section);
      totalBytes += after?.byteLength ?? 0;
      if (totalBytes > MAX_TOTAL_FILE_BYTES) throw new GitHubIntegrationError('unsafe_change');
      if (section.afterPath === null) {
        if (after !== null) throw new GitHubIntegrationError('unsafe_change');
        newTreeEntries.push({
          path: expectedFile.path,
          mode: modeForEntry(existingEntry?.mode),
          type: 'blob',
          sha: null,
        });
        continue;
      }
      if (after === null || after.byteLength > MAX_FILE_BYTES) throw new GitHubIntegrationError('unsafe_change');
      const blobResponse = await this.apiJson(`/repos/${PINNED_GITHUB_REPOSITORY}/git/blobs`, input.accessToken, {
        method: 'POST',
        body: JSON.stringify({ content: after.toString('base64'), encoding: 'base64' }),
      });
      const blob = GitObjectShaResponseSchema.safeParse(blobResponse);
      if (!blob.success) throw new GitHubIntegrationError('invalid_response');
      newTreeEntries.push({
        path: expectedFile.path,
        mode: modeForEntry(existingEntry?.mode),
        type: 'blob',
        sha: blob.data.sha,
      });
    }

    const createdTreeResponse = await this.apiJson(`/repos/${PINNED_GITHUB_REPOSITORY}/git/trees`, input.accessToken, {
      method: 'POST',
      body: JSON.stringify({ base_tree: baseTree.data.sha, tree: newTreeEntries }),
    });
    const createdTree = GitObjectShaResponseSchema.safeParse(createdTreeResponse);
    if (!createdTree.success || createdTree.data.sha === baseTree.data.sha) {
      throw new GitHubIntegrationError('unsafe_change');
    }
    const currentPull = await this.getValidatedPullRequest({
      accessToken: input.accessToken,
      pullRequestNumber: input.pullRequestNumber,
      expectedHeadSha: approvedExpectedHeadSha,
    });
    if (currentPull.headRef !== initialPull.headRef) throw new GitHubIntegrationError('head_changed');
    await this.assertBranchHead(input.accessToken, currentPull.headRef, approvedExpectedHeadSha);
    return { pull: currentPull, expectedHeadSha: approvedExpectedHeadSha, treeSha: createdTree.data.sha };
  }

  private async createGitCommit(input: { accessToken: string; message: string; treeSha: string; parentSha: string }) {
    const response = await this.apiJson(`/repos/${PINNED_GITHUB_REPOSITORY}/git/commits`, input.accessToken, {
      method: 'POST',
      body: JSON.stringify({ message: input.message, tree: input.treeSha, parents: [input.parentSha] }),
    });
    const commit = GitCommitResponseSchema.safeParse(response);
    if (!commit.success) throw new GitHubIntegrationError('invalid_response');
    return commit;
  }

  private async readBranchHead(accessToken: string, branch: string): Promise<string | null> {
    try {
      const response = await this.apiJson(
        `/repos/${PINNED_GITHUB_REPOSITORY}/git/ref/heads/${encodeBranch(branch)}`,
        accessToken,
        { method: 'GET' }
      );
      const reference = GitReferenceResponseSchema.safeParse(response);
      if (!reference.success) throw new GitHubIntegrationError('invalid_response');
      return reference.data.object.sha;
    } catch (error) {
      if (error instanceof GitHubIntegrationError && error.code === 'not_found') return null;
      throw error;
    }
  }

  private async validateProposalCommit(
    accessToken: string,
    commitSha: string,
    expectedParentSha: string,
    expectedTreeSha: string
  ) {
    const response = await this.apiJson(`/repos/${PINNED_GITHUB_REPOSITORY}/git/commits/${commitSha}`, accessToken, {
      method: 'GET',
    });
    const commit = GitCommitResponseSchema.safeParse(response);
    if (
      !commit.success ||
      commit.data.tree?.sha !== expectedTreeSha ||
      commit.data.parents?.length !== 1 ||
      commit.data.parents[0]?.sha !== expectedParentSha
    ) {
      throw new GitHubIntegrationError('conflict');
    }
    return commit.data;
  }

  private async assertBranchHead(accessToken: string, branch: string, expectedSha: string): Promise<void> {
    const response = await this.apiJson(
      `/repos/${PINNED_GITHUB_REPOSITORY}/git/ref/heads/${encodeBranch(branch)}`,
      accessToken,
      { method: 'GET' }
    );
    const reference = GitReferenceResponseSchema.safeParse(response);
    if (!reference.success) throw new GitHubIntegrationError('invalid_response');
    if (reference.data.object.sha !== expectedSha) throw new GitHubIntegrationError('head_changed');
  }

  private async loadTextBlob(accessToken: string, sha: string): Promise<Buffer> {
    const response = await this.apiJson(`/repos/${PINNED_GITHUB_REPOSITORY}/git/blobs/${sha}`, accessToken, {
      method: 'GET',
    });
    const blob = GitBlobResponseSchema.safeParse(response);
    if (!blob.success) throw new GitHubIntegrationError('invalid_response');
    const normalized = blob.data.content.replace(/\s/gu, '');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(normalized, 'base64');
    } catch {
      throw new GitHubIntegrationError('invalid_response');
    }
    if (bytes.byteLength !== blob.data.size || bytes.toString('base64') !== normalized) {
      throw new GitHubIntegrationError('invalid_response');
    }
    validateTextBytes(bytes);
    return bytes;
  }

  private async apiJson(path: string, accessToken: string, init: RequestInit): Promise<unknown> {
    validateAccessToken(accessToken);
    return this.requestJson(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        ...init.headers,
      },
    });
  }

  private async requestJson(url: string, init: RequestInit, mapApiErrors = true): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch {
      throw new GitHubIntegrationError('request_failed', true);
    }
    if (!response.ok) {
      if (mapApiErrors) throw mapHttpError(response);
      throw new GitHubIntegrationError('request_failed', response.status >= 500);
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new GitHubIntegrationError('request_failed', true);
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_JSON_RESPONSE_BYTES) {
      throw new GitHubIntegrationError('invalid_response');
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GitHubIntegrationError('invalid_response');
    }
  }

  private async requestNoContent(url: string, init: RequestInit): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch {
      throw new GitHubIntegrationError('request_failed', true);
    }
    if (!response.ok) throw mapHttpError(response);
  }
}

function parseConfig(config: GitHubAppOAuthConfig): GitHubAppOAuthConfig {
  const parsed = z
    .object({
      clientId: z.string().regex(/^[A-Za-z0-9._-]{10,128}$/),
      clientSecret: z.string().min(20).max(512),
      redirectUri: z.string().url(),
    })
    .strict()
    .safeParse(config);
  if (!parsed.success) throw new GitHubIntegrationError('invalid_configuration');
  const redirect = new URL(parsed.data.redirectUri);
  const localHttp =
    redirect.protocol === 'http:' && (redirect.hostname === '127.0.0.1' || redirect.hostname === 'localhost');
  if (
    (redirect.protocol !== 'https:' && !localHttp) ||
    redirect.username !== '' ||
    redirect.password !== '' ||
    redirect.hash !== ''
  ) {
    throw new GitHubIntegrationError('invalid_configuration');
  }
  return parsed.data;
}

function mapHttpError(response: Response): GitHubIntegrationError {
  switch (response.status) {
    case 401:
      return new GitHubIntegrationError('unauthorized');
    case 403:
      return response.headers.get('x-ratelimit-remaining') === '0'
        ? new GitHubIntegrationError('rate_limited', true)
        : new GitHubIntegrationError('forbidden');
    case 404:
      return new GitHubIntegrationError('not_found');
    case 409:
    case 422:
      return new GitHubIntegrationError('conflict');
    case 429:
      return new GitHubIntegrationError('rate_limited', true);
    default:
      return new GitHubIntegrationError('request_failed', response.status >= 500);
  }
}

function bindExpectedFiles(
  rawExpectedFiles: ExpectedFileVersion[],
  descriptors: ChangedFileDescriptor[]
): ExpectedFileVersion[] {
  const parsed = z.array(ExpectedFileVersionSchema).min(1).max(MAX_CHANGED_FILES).safeParse(rawExpectedFiles);
  if (!parsed.success) throw new GitHubIntegrationError('unsafe_change');
  const expectedFiles = parsed.data;
  const descriptorByPath = new Map<string, ChangedFileDescriptor>();
  for (const descriptor of descriptors) {
    if (
      descriptor.beforePath !== null &&
      descriptor.afterPath !== null &&
      descriptor.beforePath !== descriptor.afterPath
    ) {
      throw new GitHubIntegrationError('unsafe_change');
    }
    const path = descriptor.afterPath ?? descriptor.beforePath;
    if (path === null || descriptorByPath.has(path)) throw new GitHubIntegrationError('unsafe_change');
    descriptorByPath.set(path, descriptor);
  }
  if (expectedFiles.length !== descriptorByPath.size) throw new GitHubIntegrationError('unsafe_change');
  const seen = new Set<string>();
  for (const expected of expectedFiles) {
    const descriptor = descriptorByPath.get(expected.path);
    if (descriptor === undefined || seen.has(expected.path)) {
      throw new GitHubIntegrationError('unsafe_change');
    }
    seen.add(expected.path);
    const isAddition = descriptor.beforePath === null;
    if (isAddition !== (expected.expectedBlobSha === null)) {
      throw new GitHubIntegrationError('unsafe_change');
    }
  }
  return expectedFiles;
}

function compareExpectedTree(
  expectedFiles: ExpectedFileVersion[],
  entries: Map<string, { mode: string; type: string; sha: string }>
): void {
  for (const expected of expectedFiles) {
    const observed = entries.get(expected.path);
    if (expected.expectedBlobSha === null) {
      if (observed !== undefined) throw new GitHubIntegrationError('head_changed');
      continue;
    }
    if (
      observed === undefined ||
      observed.type !== 'blob' ||
      (observed.mode !== '100644' && observed.mode !== '100755') ||
      observed.sha !== expected.expectedBlobSha
    ) {
      throw new GitHubIntegrationError('head_changed');
    }
  }
}

function parsePatchSections(bytes: Buffer, descriptors: ChangedFileDescriptor[]): Map<string, ParsedPatchSection> {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GitHubIntegrationError('unsafe_change');
  }
  const lines = text.split('\n');
  const sections = new Map<string, ParsedPatchSection>();
  let current: ParsedPatchSection | null = null;
  let currentHunk: ParsedHunk | null = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = { path: '', beforePath: null, afterPath: null, hunks: [] };
      currentHunk = null;
      continue;
    }
    if (current === null) continue;
    if (current.hunks.length === 0 && line.startsWith('--- ')) {
      current.beforePath = patchPath(line.slice(4), 'a/');
      continue;
    }
    if (current.hunks.length === 0 && line.startsWith('+++ ')) {
      current.afterPath = patchPath(line.slice(4), 'b/');
      const path = current.afterPath ?? current.beforePath;
      if (path === null || sections.has(path)) throw new GitHubIntegrationError('unsafe_change');
      current.path = path;
      sections.set(path, current);
      continue;
    }
    if (line.startsWith('@@ ')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(line);
      if (match === null) throw new GitHubIntegrationError('unsafe_change');
      currentHunk = {
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      current.hunks.push(currentHunk);
      continue;
    }
    if (currentHunk !== null) {
      if (
        line.startsWith(' ') ||
        line.startsWith('+') ||
        line.startsWith('-') ||
        line === '\\ No newline at end of file'
      ) {
        currentHunk.lines.push(line);
      } else if (line.length > 0) {
        throw new GitHubIntegrationError('unsafe_change');
      }
    }
  }
  if (sections.size !== descriptors.length) throw new GitHubIntegrationError('unsafe_change');
  for (const section of sections.values()) {
    if (section.hunks.length === 0) throw new GitHubIntegrationError('unsafe_change');
  }
  return sections;
}

function applyPatchSection(before: Buffer, section: ParsedPatchSection): Buffer | null {
  validateTextBytes(before);
  const beforeText = before.toString('utf8');
  const beforeEndsWithNewline = beforeText.endsWith('\n');
  const beforeLines = beforeText.length === 0 ? [] : beforeText.split('\n');
  if (beforeEndsWithNewline) beforeLines.pop();
  const afterLines: string[] = [];
  let sourceIndex = 0;
  let targetEndsWithNewline = section.afterPath === null ? false : beforeEndsWithNewline || section.beforePath === null;

  for (const hunk of section.hunks) {
    const hunkStart = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (hunkStart < sourceIndex || hunkStart > beforeLines.length) {
      throw new GitHubIntegrationError('unsafe_change');
    }
    afterLines.push(...beforeLines.slice(sourceIndex, hunkStart));
    sourceIndex = hunkStart;
    let observedOld = 0;
    let observedNew = 0;
    let lastPrefix: ' ' | '+' | '-' | null = null;
    for (const patchLine of hunk.lines) {
      if (patchLine === '\\ No newline at end of file') {
        if (lastPrefix === ' ' || lastPrefix === '+') targetEndsWithNewline = false;
        continue;
      }
      const prefix = patchLine[0];
      const content = patchLine.slice(1);
      if (prefix === ' ') {
        if (beforeLines[sourceIndex] !== content) throw new GitHubIntegrationError('unsafe_change');
        afterLines.push(content);
        sourceIndex += 1;
        observedOld += 1;
        observedNew += 1;
        lastPrefix = ' ';
      } else if (prefix === '-') {
        if (beforeLines[sourceIndex] !== content) throw new GitHubIntegrationError('unsafe_change');
        sourceIndex += 1;
        observedOld += 1;
        lastPrefix = '-';
      } else if (prefix === '+') {
        afterLines.push(content);
        observedNew += 1;
        lastPrefix = '+';
      } else {
        throw new GitHubIntegrationError('unsafe_change');
      }
    }
    if (observedOld !== hunk.oldCount || observedNew !== hunk.newCount) {
      throw new GitHubIntegrationError('unsafe_change');
    }
  }
  afterLines.push(...beforeLines.slice(sourceIndex));
  if (section.afterPath === null) {
    if (afterLines.length !== 0) throw new GitHubIntegrationError('unsafe_change');
    return null;
  }
  const output = `${afterLines.join('\n')}${targetEndsWithNewline ? '\n' : ''}`;
  const bytes = Buffer.from(output, 'utf8');
  validateTextBytes(bytes);
  return bytes;
}

function patchPath(value: string, prefix: 'a/' | 'b/'): string | null {
  if (value === '/dev/null') return null;
  if (!value.startsWith(prefix) || value.includes('\t') || value.includes('"')) {
    throw new GitHubIntegrationError('unsafe_change');
  }
  return value.slice(prefix.length);
}

function modeForEntry(mode: string | undefined): '100644' | '100755' {
  if (mode === undefined || mode === '100644') return '100644';
  if (mode === '100755') return '100755';
  throw new GitHubIntegrationError('unsafe_change');
}

function proposalResult(
  pullRequestNumber: number,
  previousHeadSha: string,
  branch: string,
  commit: z.infer<typeof GitCommitResponseSchema>
): CreatedProposal {
  return {
    repository: PINNED_GITHUB_REPOSITORY,
    pullRequestNumber,
    previousHeadSha,
    branch,
    commitSha: commit.sha,
    commitUrl: commit.html_url ?? null,
  };
}

function validateTextBytes(bytes: Buffer): void {
  if (bytes.byteLength > MAX_FILE_BYTES || bytes.includes(0)) {
    throw new GitHubIntegrationError('unsafe_change');
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GitHubIntegrationError('unsafe_change');
  }
}

function validateBranchName(value: string): string {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.includes('//') ||
    value.includes('@{') ||
    hasUnsafeControlCharacter(value) ||
    value.split('/').some((segment) => !BRANCH_SEGMENT_PATTERN.test(segment))
  ) {
    throw new GitHubIntegrationError('invalid_response');
  }
  return value;
}

function encodeBranch(value: string): string {
  return validateBranchName(value)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function validateCommitMessage(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    value !== value.trim() ||
    hasUnsafeControlCharacter(value)
  ) {
    throw new GitHubIntegrationError('invalid_request');
  }
  return value;
}

function validateAccessToken(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || hasTokenSeparator(value)) {
    throw new GitHubIntegrationError('unauthorized');
  }
}

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function parseScopes(value: string): string[] {
  return [...new Set(value.split(/[ ,]+/u).filter((scope) => scope.length > 0))].sort();
}

function mapOAuthTokens(value: z.infer<typeof OAuthTokenResponseSchema>, now: Date): GitHubOAuthTokens {
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token ?? null,
    tokenType: value.token_type,
    scopes: parseScopes(value.scope),
    expiresAt: expiryFromSeconds(now, value.expires_in),
    refreshTokenExpiresAt: expiryFromSeconds(now, value.refresh_token_expires_in),
  };
}

function expiryFromSeconds(now: Date, seconds: number | undefined): string | null {
  return seconds === undefined ? null : new Date(now.getTime() + seconds * 1000).toISOString();
}

function validateDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new GitHubIntegrationError('invalid_request');
  return value;
}

function parseRequestedCommitSha(value: string): string {
  const parsed = CommitShaSchema.safeParse(value);
  if (!parsed.success) throw new GitHubIntegrationError('invalid_request');
  return parsed.data;
}

function hasUnsafeControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if ((codePoint <= 0x1f && codePoint !== 0x0a) || codePoint === 0x7f) return true;
  }
  return false;
}

function hasTokenSeparator(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}
