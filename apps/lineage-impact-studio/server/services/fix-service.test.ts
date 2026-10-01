import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import type { AssessmentViewV3, SourceEvidenceView } from '../domain/assessment-view';
import { GitHubAppClient, type ValidatedPullRequest } from '../integrations/github';
import { OmnigentClient, OmnigentIntegrationError } from '../integrations/omnigent';
import { WorkspaceGitCredentialClient } from '../integrations/omnigent/git-credential-client';
import {
  LineageImpactRepository,
  type GitHubUserCredential,
  type OmnigentSessionView,
} from '../persistence/repository';
import { Aes256GcmCipher } from '../security/encryption';
import { validatePatchCandidate } from '../security/patch-policy';
import { FixService } from './fix-service';

const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const ACTOR = 'databricks-user-123';

const assessment: AssessmentViewV3 = {
  schemaVersion: 3,
  reference: 'lgr_HW7ZIvqub0ZNh27dZ9rv-oICUYz91PGP',
  detailState: 'available',
  status: 'block',
  severity: 'high',
  message: 'A potentially breaking downstream impact was identified.',
  headline: 'A downstream consumer is affected.',
  recommendedAction: 'Update the verified consumer.',
  source: {
    provider: 'github',
    createdAt: '2026-09-29T00:00:00.000Z',
    freshness: 'current',
    evidenceOrigin: 'proposed_code',
  },
  pullRequest: {
    repository: 'db-afeng/proactive-zero-ops',
    number: 42,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
  },
  viewer: { subject: ACTOR, displayName: 'Reviewer' },
  confidence: { interpretation: 0.9, discovery: 'complete' },
  changes: [],
  impacts: [],
  graph: { nodes: [], edges: [] },
  disclosure: { state: 'full', notice: 'All referenced lineage assets are visible to you.' },
};

const sourceEvidence: SourceEvidenceView = {
  schemaVersion: 1,
  assessmentReference: assessment.reference,
  pullRequestFilesUrl: 'https://github.com/db-afeng/proactive-zero-ops/pull/42/files',
  changes: [],
  impacts: [],
};

const credential: GitHubUserCredential = {
  accessToken: 'github-user-token',
  refreshToken: null,
  tokenType: 'bearer',
  scopes: [],
  expiresAt: null,
  refreshTokenExpiresAt: null,
};

const pull: ValidatedPullRequest = {
  number: 42,
  repository: 'db-afeng/proactive-zero-ops',
  state: 'open',
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
  headRef: 'feature/lineage-fix',
  canPush: true,
  isFork: false,
};

describe('FixService failure handling', () => {
  it('retains a safe failed local session when managed Omnigent dispatch fails', async () => {
    const queued = session('queued');
    const failed = session('failed', 'Omnigent is temporarily unavailable');
    const repository = testRepository();
    vi.spyOn(repository, 'createOmnigentSession').mockResolvedValue(queued);
    const transition = vi.spyOn(repository, 'transitionOmnigentSession').mockResolvedValue(failed);
    const github = testGitHub();
    vi.spyOn(github, 'getValidatedPullRequest').mockResolvedValue(pull);
    const omnigent = testOmnigent();
    vi.spyOn(omnigent, 'createManagedSession').mockRejectedValue(
      new OmnigentIntegrationError('unavailable', 503, true)
    );
    const service = new FixService(repository, github, omnigent);

    await expect(
      service.start({
        actorSubject: ACTOR,
        assessment,
        sourceEvidence,
        guidance: 'Preserve the consumer contract.',
        credential,
        omnigentAuth: { oboToken: 'obo-token' },
      })
    ).resolves.toEqual(failed);
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', expectedStatuses: ['queued', 'running', 'validating'] })
    );
  });

  it('binds a managed session that reports a repository clone failure during dispatch', async () => {
    const queued = session('queued');
    const failed = session(
      'failed',
      'Omnigent could not clone this private repository. Configure a Git credential for the Omnigent execution identity and try again.',
      'provider-session'
    );
    const repository = testRepository();
    vi.spyOn(repository, 'createOmnigentSession').mockResolvedValue(queued);
    const transition = vi.spyOn(repository, 'transitionOmnigentSession').mockResolvedValue(failed);
    const github = testGitHub();
    vi.spyOn(github, 'getValidatedPullRequest').mockResolvedValue(pull);
    const omnigent = testOmnigent();
    vi.spyOn(omnigent, 'createManagedSession').mockResolvedValue({
      authMode: 'service-principal',
      value: {
        id: 'provider-session',
        status: 'failed',
        runnerOnline: false,
        hostOnline: false,
        sandboxStage: 'failed',
        error:
          'Omnigent could not clone this private repository. Configure a Git credential for the Omnigent execution identity and try again.',
      },
    });
    const service = new FixService(repository, github, omnigent);

    await expect(
      service.start({
        actorSubject: ACTOR,
        assessment,
        sourceEvidence,
        guidance: 'Preserve the consumer contract.',
        credential,
        omnigentAuth: { oboToken: 'obo-token' },
      })
    ).resolves.toEqual(failed);
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        expectedStatuses: ['queued'],
        providerSessionId: 'provider-session',
      })
    );
  });

  it('binds a caller-owned Git credential without creating or deleting an app credential', async () => {
    const queued = session('queued');
    const running = session(
      'running',
      'Omnigent is preparing an isolated workspace on your behalf.',
      'provider-session'
    );
    const repository = testRepository();
    vi.spyOn(repository, 'createOmnigentSession').mockResolvedValue(queued);
    vi.spyOn(repository, 'transitionOmnigentSession').mockResolvedValue(running);
    const attach = vi.spyOn(repository, 'attachGitCredential').mockResolvedValue();
    const github = testGitHub();
    vi.spyOn(github, 'getValidatedPullRequest').mockResolvedValue(pull);
    const omnigent = testOmnigent();
    const createManagedSession = vi.spyOn(omnigent, 'createManagedSession').mockResolvedValue({
      authMode: 'obo',
      value: {
        id: 'provider-session',
        status: 'idle',
        runnerOnline: false,
        hostOnline: false,
        sandboxStage: 'provisioning',
        error: null,
      },
    });
    const gitCredentials = testGitCredentials();
    const createCredential = vi.spyOn(gitCredentials, 'create').mockResolvedValue(987654321);
    const deleteCredential = vi.spyOn(gitCredentials, 'delete').mockResolvedValue();
    const service = new FixService(repository, github, omnigent, gitCredentials);

    await service.start({
      actorSubject: ACTOR,
      assessment,
      sourceEvidence,
      guidance: 'Preserve the consumer contract.',
      credential,
      omnigentAuth: { oboToken: 'ci-obo-token', allowServicePrincipalFallback: false },
      gitCredentialId: 123456789,
    });

    expect(createManagedSession).toHaveBeenCalledWith(expect.objectContaining({ gitCredentialId: 123456789 }), {
      oboToken: 'ci-obo-token',
      allowServicePrincipalFallback: false,
    });
    await service.releaseSessionGitCredential(ACTOR, { ...running, status: 'complete' });
    expect(attach).not.toHaveBeenCalled();
    expect(createCredential).not.toHaveBeenCalled();
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it('creates and later removes an app-owned Git credential for a Fix tab retry', async () => {
    const queued = session('queued');
    const running = session(
      'running',
      'Omnigent is preparing an isolated workspace using the app service principal.',
      'provider-session'
    );
    running.gitCredentialId = 987654321;
    const complete = session('complete', 'Validated patch ready for review.', 'provider-session');
    complete.gitCredentialId = 987654321;
    const repository = testRepository();
    vi.spyOn(repository, 'createOmnigentSession').mockResolvedValue(queued);
    const attach = vi.spyOn(repository, 'attachGitCredential').mockResolvedValue();
    vi.spyOn(repository, 'transitionOmnigentSession').mockResolvedValue(running);
    const clear = vi.spyOn(repository, 'clearGitCredential').mockResolvedValue();
    const github = testGitHub();
    vi.spyOn(github, 'getValidatedPullRequest').mockResolvedValue(pull);
    const omnigent = testOmnigent();
    const createManagedSession = vi.spyOn(omnigent, 'createManagedSession').mockResolvedValue({
      authMode: 'service-principal',
      value: {
        id: 'provider-session',
        status: 'idle',
        runnerOnline: false,
        hostOnline: false,
        sandboxStage: 'provisioning',
        error: null,
      },
    });
    const gitCredentials = testGitCredentials();
    const createCredential = vi.spyOn(gitCredentials, 'create').mockResolvedValue(987654321);
    const deleteCredential = vi.spyOn(gitCredentials, 'delete').mockResolvedValue();
    const service = new FixService(repository, github, omnigent, gitCredentials);

    await expect(
      service.start({
        actorSubject: ACTOR,
        assessment,
        sourceEvidence,
        guidance: 'Preserve the consumer contract.',
        credential,
        omnigentAuth: { oboToken: null },
        useAppGitCredential: true,
      })
    ).resolves.toEqual(running);
    expect(createCredential).toHaveBeenCalledWith(credential.accessToken, queued.id);
    expect(attach).toHaveBeenCalledWith({ actorSubject: ACTOR, sessionId: queued.id, credentialId: 987654321 });
    expect(createManagedSession).toHaveBeenCalledWith(expect.objectContaining({ gitCredentialId: 987654321 }), {
      oboToken: null,
    });
    expect(deleteCredential).not.toHaveBeenCalled();

    await service.releaseSessionGitCredential(ACTOR, complete);
    expect(deleteCredential).toHaveBeenCalledWith(987654321);
    expect(clear).toHaveBeenCalledWith({ actorSubject: ACTOR, sessionId: queued.id, credentialId: 987654321 });
  });

  it('removes an app-owned credential when Omnigent startup fails', async () => {
    const queued = session('queued');
    const failed = session('failed', 'Omnigent is temporarily unavailable');
    failed.gitCredentialId = 987654321;
    const repository = testRepository();
    vi.spyOn(repository, 'createOmnigentSession').mockResolvedValue(queued);
    vi.spyOn(repository, 'attachGitCredential').mockResolvedValue();
    vi.spyOn(repository, 'transitionOmnigentSession').mockResolvedValue(failed);
    const clear = vi.spyOn(repository, 'clearGitCredential').mockResolvedValue();
    const github = testGitHub();
    vi.spyOn(github, 'getValidatedPullRequest').mockResolvedValue(pull);
    const omnigent = testOmnigent();
    vi.spyOn(omnigent, 'createManagedSession').mockRejectedValue(
      new OmnigentIntegrationError('unavailable', 503, true)
    );
    const gitCredentials = testGitCredentials();
    vi.spyOn(gitCredentials, 'create').mockResolvedValue(987654321);
    const remove = vi.spyOn(gitCredentials, 'delete').mockResolvedValue();
    const service = new FixService(repository, github, omnigent, gitCredentials);

    await expect(
      service.start({
        actorSubject: ACTOR,
        assessment,
        sourceEvidence,
        guidance: 'Preserve the consumer contract.',
        credential,
        omnigentAuth: { oboToken: null },
        useAppGitCredential: true,
      })
    ).resolves.toEqual(failed);
    expect(remove).toHaveBeenCalledWith(987654321);
    expect(clear).toHaveBeenCalledWith({ actorSubject: ACTOR, sessionId: queued.id, credentialId: 987654321 });
  });

  it('cleans up a terminal session credential after a restart', async () => {
    const complete = session('complete', 'Validated patch ready for review.', 'provider-session');
    complete.gitCredentialId = 987654321;
    const repository = testRepository();
    vi.spyOn(repository, 'listGitCredentialsToClean').mockResolvedValue([{ actorSubject: ACTOR, session: complete }]);
    const clear = vi.spyOn(repository, 'clearGitCredential').mockResolvedValue();
    const gitCredentials = testGitCredentials();
    const remove = vi.spyOn(gitCredentials, 'delete').mockResolvedValue();
    const service = new FixService(repository, testGitHub(), testOmnigent(), gitCredentials);

    await service.cleanupAbandonedGitCredentials();
    expect(remove).toHaveBeenCalledWith(987654321);
    expect(clear).toHaveBeenCalledWith({ actorSubject: ACTOR, sessionId: complete.id, credentialId: 987654321 });
  });

  it('fails closed when an idle Omnigent session produced no source changes', async () => {
    const running = session('running', 'Omnigent is proposing a fix.', 'provider-session');
    const validating = session('validating', 'Validating.', 'provider-session');
    const failed = session('failed', 'Omnigent completed without producing source changes.', 'provider-session');
    const repository = testRepository();
    vi.spyOn(repository, 'transitionOmnigentSession').mockResolvedValueOnce(validating).mockResolvedValueOnce(failed);
    vi.spyOn(repository, 'getValidatedPatchMetadataForSession').mockResolvedValue(null);
    const github = testGitHub();
    const getPull = vi.spyOn(github, 'getValidatedPullRequest');
    const omnigent = testOmnigent();
    vi.spyOn(omnigent, 'getSession').mockResolvedValue({
      authMode: 'obo',
      value: {
        id: 'provider-session',
        status: 'idle',
        runnerOnline: true,
        hostOnline: true,
        sandboxStage: null,
        error: null,
      },
    });
    vi.spyOn(omnigent, 'listChangedFiles').mockResolvedValue({ authMode: 'obo', value: [] });
    const service = new FixService(repository, github, omnigent);

    await expect(
      service.synchronize({
        actorSubject: ACTOR,
        session: running,
        assessment,
        credential,
        omnigentAuth: { oboToken: 'obo-token' },
      })
    ).resolves.toEqual(failed);
    expect(getPull).not.toHaveBeenCalled();
  });

  it('keeps a manual session active when its short-lived user authorization must be renewed', async () => {
    const running = session('running', 'Omnigent is proposing a fix.', 'provider-session');
    const repository = testRepository();
    const transition = vi.spyOn(repository, 'transitionOmnigentSession');
    const omnigent = testOmnigent();
    vi.spyOn(omnigent, 'getSession').mockRejectedValue(new OmnigentIntegrationError('forbidden', 403));
    const service = new FixService(repository, testGitHub(), omnigent);

    await expect(
      service.synchronize({
        actorSubject: ACTOR,
        session: running,
        assessment,
        credential,
        omnigentAuth: { oboToken: 'user-token', allowServicePrincipalFallback: false },
        propagateAuthFailure: true,
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(transition).not.toHaveBeenCalled();
  });

  it('publishes the validated patch on a deterministic proposal branch before completion', async () => {
    const validating = session('validating', 'Validating.', 'provider-session');
    const complete = session('complete', 'Validated patch ready for review.', 'provider-session');
    const path = 'src/lineage/check.py';
    const controlled = validatePatchCandidate({
      gate: {
        baseRepository: pull.repository,
        headRepository: pull.repository,
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
          beforePath: path,
          afterPath: path,
          binary: false,
          generated: false,
          beforeType: 'regular',
          afterType: 'regular',
        },
      ],
      patch: [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n'),
    });
    const repository = testRepository();
    vi.spyOn(repository, 'getFixProposalForSession').mockResolvedValue(null);
    vi.spyOn(repository, 'loadDecryptedValidatedPatchForSession').mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      sessionId: validating.id,
      expectedHeadSha: HEAD_SHA,
      patchDigest: controlled.digest,
      files: controlled.files,
      createdAt: '2026-09-29T00:00:00.000Z',
      bytes: controlled.bytes,
      expectedFiles: [{ path, expectedBlobSha: 'd'.repeat(40) }],
    });
    const storeProposal = vi.spyOn(repository, 'storeFixProposal').mockResolvedValue({
      sessionId: validating.id,
      repository: pull.repository,
      branch: 'omnigent/pr-42/11111111',
      commitSha: 'e'.repeat(40),
      commitUrl: 'https://github.com/db-afeng/proactive-zero-ops/commit/example',
      createdAt: '2026-09-29T00:01:00.000Z',
    });
    vi.spyOn(repository, 'transitionOmnigentSession').mockResolvedValue(complete);
    const github = testGitHub();
    const createProposal = vi.spyOn(github, 'createProposalCommitFromValidatedPatch').mockResolvedValue({
      repository: pull.repository,
      pullRequestNumber: 42,
      previousHeadSha: HEAD_SHA,
      branch: 'omnigent/pr-42/11111111',
      commitSha: 'e'.repeat(40),
      commitUrl: 'https://github.com/db-afeng/proactive-zero-ops/commit/example',
    });
    const service = new FixService(repository, github, testOmnigent());

    await expect(
      service.publishProposalAndComplete({ actorSubject: ACTOR, assessment, credential }, validating)
    ).resolves.toEqual(complete);
    expect(createProposal).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'omnigent/pr-42/11111111', expectedHeadSha: HEAD_SHA })
    );
    expect(storeProposal).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'omnigent/pr-42/11111111', commitSha: 'e'.repeat(40) })
    );
  });
});

function session(
  status: OmnigentSessionView['status'],
  statusMessage: string | null = null,
  providerSessionId: string | null = null
): OmnigentSessionView {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    providerSessionId,
    gitCredentialId: null,
    assessmentReference: assessment.reference,
    expectedHeadSha: HEAD_SHA,
    authorizedEvidenceDigest: `sha256:${'c'.repeat(64)}`,
    guidance: 'Preserve the consumer contract.',
    status,
    statusMessage,
    cancelRequestedAt: null,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    finishedAt: status === 'failed' ? '2026-09-29T00:01:00.000Z' : null,
  };
}

function testRepository(): LineageImpactRepository {
  return new LineageImpactRepository(
    { query: vi.fn().mockResolvedValue({ rows: [] }) },
    new Aes256GcmCipher(Buffer.alloc(32, 7))
  );
}

function testGitHub(): GitHubAppClient {
  return new GitHubAppClient(
    {
      clientId: 'github-client-id',
      clientSecret: 'github-client-secret',
      redirectUri: 'https://lineage-impact.example/api/github/oauth/callback',
    },
    vi.fn()
  );
}

function testOmnigent(): OmnigentClient {
  return new OmnigentClient({
    workspaceHost: 'https://workspace.example.databricks.com',
    fetchImplementation: vi.fn(),
  });
}

function testGitCredentials(): WorkspaceGitCredentialClient {
  return new WorkspaceGitCredentialClient({
    workspaceHost: 'https://workspace.example.databricks.com',
    tokenProvider: { getToken: vi.fn().mockResolvedValue('app-service-principal-token') },
    fetchImplementation: vi.fn(),
  });
}
