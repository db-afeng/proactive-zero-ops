import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import type { AssessmentViewV3, SourceEvidenceView } from '../domain/assessment-view';
import { GitHubAppClient, type ValidatedPullRequest } from '../integrations/github';
import { OmnigentClient, OmnigentIntegrationError } from '../integrations/omnigent';
import {
  LineageImpactRepository,
  type GitHubUserCredential,
  type OmnigentSessionView,
} from '../persistence/repository';
import { Aes256GcmCipher } from '../security/encryption';
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
});

function session(
  status: OmnigentSessionView['status'],
  statusMessage: string | null = null,
  providerSessionId: string | null = null
): OmnigentSessionView {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    providerSessionId,
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
