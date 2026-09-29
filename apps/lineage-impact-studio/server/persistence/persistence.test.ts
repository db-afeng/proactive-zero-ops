import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { Aes256GcmCipher } from '../security/encryption';
import { issueOAuthAttempt } from '../security/oauth';
import { validatePatchCandidate } from '../security/patch-policy';
import { LineageImpactRepository, PersistenceError } from './repository';
import {
  LINEAGE_IMPACT_BOOTSTRAP_SQL,
  bootstrapLineageImpactStore,
  type QueryExecutor,
  type QueryResult,
} from './schema';

class ScriptedExecutor implements QueryExecutor {
  readonly calls: Array<{ text: string; params: unknown[] }> = [];
  readonly #responses: Array<QueryResult | ((text: string, params: unknown[]) => QueryResult)>;

  constructor(responses: Array<QueryResult | ((text: string, params: unknown[]) => QueryResult)> = []) {
    this.#responses = [...responses];
  }

  query(text: string, params: unknown[] = []): Promise<QueryResult> {
    this.calls.push({ text, params });
    const response = this.#responses.shift();
    if (response === undefined) return Promise.resolve({ rows: [] });
    return Promise.resolve(typeof response === 'function' ? response(text, params) : response);
  }
}

const ACTOR = 'databricks-user-123';

describe('Lakebase persistence bootstrap', () => {
  it('creates the app-owned schema and every security-sensitive table only when invoked', async () => {
    const executor = new ScriptedExecutor();
    expect(executor.calls).toHaveLength(0);

    await bootstrapLineageImpactStore(executor);

    expect(executor.calls).toHaveLength(LINEAGE_IMPACT_BOOTSTRAP_SQL.length);
    const sql = executor.calls.map((call) => call.text).join('\n');
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS lineage_impact');
    for (const table of [
      'oauth_attempts',
      'github_connections',
      'omnigent_sessions',
      'validated_patches',
      'patch_approvals',
      'commit_intents',
      'commit_audit_events',
    ]) {
      expect(sql).toContain(`lineage_impact.${table}`);
    }
    expect(sql).toContain("WHERE outcome = 'succeeded'");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS provider_session_id TEXT');
  });
});

describe('LineageImpactRepository', () => {
  it('stores only OAuth state digests and consumes state atomically for the same actor and binding', async () => {
    const binding = 'b'.repeat(48);
    const issued = issueOAuthAttempt({ binding, now: new Date('2026-09-28T00:00:00.000Z') });
    const executor = new ScriptedExecutor([
      { rows: [{ state_hash: issued.record.stateDigest }] },
      { rows: [{ pkce_verifier: issued.record.codeVerifier }] },
    ]);
    const repository = new LineageImpactRepository(executor, new Aes256GcmCipher(randomBytes(32)));

    await repository.createOAuthAttempt({ actorSubject: ACTOR, record: issued.record });
    const consumeResult = await repository.consumeOAuthAttempt({
      actorSubject: ACTOR,
      submittedState: issued.state,
      binding,
      now: new Date('2026-09-28T00:01:00.000Z'),
    });

    expect(consumeResult.codeVerifier).toBe(issued.record.codeVerifier);
    expect(executor.calls[0]?.params).not.toContain(issued.state);
    expect(executor.calls[1]?.text).toContain('consumed_at IS NULL');
    expect(executor.calls[1]?.text).toContain('actor_subject = $2');
    expect(executor.calls[1]?.params[1]).toBe(ACTOR);
    expect(executor.calls[1]?.params).not.toContain(issued.state);
    expect(executor.calls[1]?.params).not.toContain(binding);
  });

  it('returns one generic failure for missing, expired, or replayed OAuth state', async () => {
    const repository = new LineageImpactRepository(
      new ScriptedExecutor([{ rows: [] }]),
      new Aes256GcmCipher(randomBytes(32))
    );
    await expect(
      repository.consumeOAuthAttempt({
        actorSubject: ACTOR,
        submittedState: 's'.repeat(43),
        binding: 'c'.repeat(40),
      })
    ).rejects.toMatchObject({ code: 'invalid_oauth_attempt' } satisfies Partial<PersistenceError>);
  });

  it('encrypts GitHub credentials and exposes only a ciphertext-free connection DTO', async () => {
    const accessToken = 'ghu_sensitive_access_token';
    let encryptedValue: unknown;
    const executor = new ScriptedExecutor([
      (_text, params) => {
        encryptedValue = params[4];
        return {
          rows: [
            {
              github_user_id: '42',
              github_login: 'octocat',
              github_display_name: 'The Octocat',
              token_expires_at: '2026-09-29T00:00:00.000Z',
              connected_at: '2026-09-28T00:00:00.000Z',
              updated_at: '2026-09-28T00:00:00.000Z',
            },
          ],
        };
      },
      () => ({ rows: [{ encrypted_credentials: encryptedValue }] }),
    ]);
    const repository = new LineageImpactRepository(executor, new Aes256GcmCipher(randomBytes(32)));
    const credential = {
      accessToken,
      refreshToken: 'ghr_sensitive_refresh_token',
      tokenType: 'bearer',
      scopes: [],
      expiresAt: '2026-09-29T00:00:00.000Z',
      refreshTokenExpiresAt: '2026-10-28T00:00:00.000Z',
    };
    const status = await repository.saveGitHubConnection({
      actorSubject: ACTOR,
      identity: { id: '42', login: 'octocat', displayName: 'The Octocat' },
      credential,
      now: new Date('2026-09-28T00:00:00.000Z'),
    });

    expect(status).toEqual({
      connected: true,
      identity: { id: '42', login: 'octocat', displayName: 'The Octocat' },
      connectedAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
      expiresAt: '2026-09-29T00:00:00.000Z',
    });
    expect(JSON.stringify(executor.calls[0]?.params)).not.toContain(accessToken);
    expect(JSON.stringify(status)).not.toContain('cipher');
    expect(await repository.loadGitHubCredential(ACTOR)).toEqual(credential);
    expect(executor.calls[1]?.params).toEqual([ACTOR]);
  });

  it('reserves commit idempotency by actor and rejects reuse for different immutable inputs', async () => {
    const intentId = '11111111-1111-4111-8111-111111111111';
    const approvalId = '22222222-2222-4222-8222-222222222222';
    const reference = `lgr_${'a'.repeat(32)}`;
    const expectedHeadSha = 'a'.repeat(40);
    const patchDigest = `sha256:${'b'.repeat(64)}`;
    const executor = new ScriptedExecutor([
      {
        rows: [
          {
            id: intentId,
            approval_id: approvalId,
            idempotency_key: 'commit-request-0001',
            assessment_reference: reference,
            repository: 'db-afeng/proactive-zero-ops',
            pull_request_number: 4,
            expected_head_sha: expectedHeadSha,
            patch_digest: patchDigest,
            created_at: '2026-09-28T00:00:00.000Z',
            created: false,
          },
        ],
      },
    ]);
    const repository = new LineageImpactRepository(executor, new Aes256GcmCipher(randomBytes(32)));

    await expect(
      repository.reserveCommit({
        actorSubject: ACTOR,
        approvalId,
        idempotencyKey: 'commit-request-0001',
        assessmentReference: reference,
        repository: 'db-afeng/proactive-zero-ops',
        pullRequestNumber: 5,
        expectedHeadSha,
        patchDigest,
      })
    ).rejects.toMatchObject({ code: 'idempotency_conflict' } satisfies Partial<PersistenceError>);
    expect(executor.calls[0]?.text).toContain('ON CONFLICT (actor_subject, idempotency_key) DO NOTHING');
    expect(executor.calls[0]?.params[0]).toBe(ACTOR);
  });

  it('stores one patch per actor/session with its compare-before-write blob versions', async () => {
    const cipher = new Aes256GcmCipher(randomBytes(32));
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const path = 'src/lineage/check.py';
    const headSha = 'a'.repeat(40);
    const patchText = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');
    const patch = validatePatchCandidate({
      gate: {
        baseRepository: 'db-afeng/proactive-zero-ops',
        headRepository: 'db-afeng/proactive-zero-ops',
        isFork: false,
        pullRequestState: 'open',
        canPush: true,
        force: false,
        commitStrategy: 'normal',
        expectedHeadSha: headSha,
        observedHeadSha: headSha,
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
      patch: patchText,
    });
    let storedRow: Record<string, unknown> = {};
    const executor = new ScriptedExecutor([
      (_text, params) => {
        storedRow = {
          id: params[0],
          session_id: params[2],
          expected_head_sha: params[3],
          patch_digest: params[4],
          changed_files: params[5],
          expected_files: params[6],
          encrypted_patch: params[7],
          created_at: params[8],
        };
        return { rows: [storedRow] };
      },
      () => ({ rows: [storedRow] }),
    ]);
    const repository = new LineageImpactRepository(executor, cipher);
    const expectedFiles = [{ path, expectedBlobSha: 'b'.repeat(40) }];

    const metadata = await repository.storeValidatedPatch({
      actorSubject: ACTOR,
      sessionId,
      patch,
      expectedFiles,
      now: new Date('2026-09-28T00:00:00.000Z'),
    });
    const loaded = await repository.loadDecryptedValidatedPatchForSession(ACTOR, sessionId);

    expect(metadata.sessionId).toBe(sessionId);
    expect(loaded?.bytes.toString('utf8')).toBe(patchText);
    expect(loaded?.expectedFiles).toEqual(expectedFiles);
    expect(executor.calls[0]?.text).toContain('ON CONFLICT (actor_subject, session_id) DO NOTHING');
    expect(executor.calls[1]?.text).toContain('actor_subject = $1 AND session_id = $2');
    expect(executor.calls[1]?.params).toEqual([ACTOR, sessionId]);
  });

  it('looks up an existing approval without implicitly creating one', async () => {
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const approvalId = '44444444-4444-4444-8444-444444444444';
    const patchId = '55555555-5555-4555-8555-555555555555';
    const headSha = 'a'.repeat(40);
    const patchDigest = `sha256:${'b'.repeat(64)}`;
    const executor = new ScriptedExecutor([
      {
        rows: [
          {
            id: approvalId,
            session_id: sessionId,
            patch_id: patchId,
            expected_head_sha: headSha,
            patch_digest: patchDigest,
            approved_at: '2026-09-28T00:02:00.000Z',
            created: false,
          },
        ],
      },
    ]);
    const repository = new LineageImpactRepository(executor, new Aes256GcmCipher(randomBytes(32)));

    const approval = await repository.getPatchApproval(ACTOR, sessionId, headSha, patchDigest);

    expect(approval?.id).toBe(approvalId);
    expect(approval?.created).toBe(false);
    expect(executor.calls[0]?.text).not.toContain('INSERT');
    expect(executor.calls[0]?.text).toContain('actor_subject = $1');
    expect(executor.calls[0]?.params).toEqual([ACTOR, sessionId, headSha, patchDigest]);
  });
});
