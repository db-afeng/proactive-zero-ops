import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import { AssessmentReferenceSchema, CommitShaSchema, GitHubRepositorySchema } from '../domain/identifiers';
import { type OAuthAttemptRecord, OAuthAttemptRecordSchema } from '../security/oauth';
import {
  ChangedFileDescriptorSchema,
  computePatchDigest,
  RepositoryPathSchema,
  validatePatchCandidate,
  type ChangedFileDescriptor,
  type ValidatedPatch,
} from '../security/patch-policy';
import { type Aes256GcmCipher } from '../security/encryption';
import { type QueryExecutor } from './schema';

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const SAFE_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const ActorSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !hasControlCharacter(value), 'Invalid actor subject');
const UuidSchema = z.string().regex(UUID_PATTERN);
const PatchDigestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const HashSchema = z.string().regex(HASH_PATTERN);
const TimestampSchema = z.union([z.date(), z.string()]).transform((value, context) => {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    context.addIssue({ code: 'custom', message: 'Invalid database timestamp' });
    return z.NEVER;
  }
  return parsed.toISOString();
});

export const GitHubUserCredentialSchema = z
  .object({
    accessToken: z.string().min(1).max(4096),
    refreshToken: z.string().min(1).max(4096).nullable(),
    tokenType: z.string().min(1).max(64),
    scopes: z.array(z.string().min(1).max(128)).max(64),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
    refreshTokenExpiresAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();

export type GitHubUserCredential = z.infer<typeof GitHubUserCredentialSchema>;

export const GitHubIdentitySchema = z
  .object({
    id: z.string().regex(/^\d{1,20}$/),
    login: z.string().min(1).max(100),
    displayName: z.string().min(1).max(255).nullable(),
  })
  .strict();

export type GitHubIdentity = z.infer<typeof GitHubIdentitySchema>;

export type GitHubConnectionStatus =
  | { connected: false }
  | {
      connected: true;
      identity: GitHubIdentity;
      connectedAt: string;
      updatedAt: string;
      expiresAt: string | null;
    };

export const OmnigentSessionStatusSchema = z.enum([
  'queued',
  'running',
  'validating',
  'complete',
  'failed',
  'cancelled',
]);
export type OmnigentSessionStatus = z.infer<typeof OmnigentSessionStatusSchema>;

export interface OmnigentSessionView {
  id: string;
  providerSessionId: string | null;
  assessmentReference: string;
  expectedHeadSha: string;
  authorizedEvidenceDigest: string;
  guidance: string | null;
  status: OmnigentSessionStatus;
  statusMessage: string | null;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface ValidatedPatchMetadata {
  id: string;
  sessionId: string;
  expectedHeadSha: string;
  patchDigest: string;
  files: ChangedFileDescriptor[];
  createdAt: string;
}

export const PersistedExpectedFileVersionSchema = z
  .object({
    path: RepositoryPathSchema,
    expectedBlobSha: CommitShaSchema.nullable(),
  })
  .strict();

export type PersistedExpectedFileVersion = z.infer<typeof PersistedExpectedFileVersionSchema>;

/** Server-only value. Never serialize this object into a browser response. */
export interface DecryptedValidatedPatch extends ValidatedPatchMetadata {
  bytes: Buffer;
  expectedFiles: PersistedExpectedFileVersion[];
}

export interface PatchApprovalView {
  id: string;
  sessionId: string;
  patchId: string;
  expectedHeadSha: string;
  patchDigest: string;
  approvedAt: string;
  created: boolean;
}

export interface CommitIntentView {
  id: string;
  approvalId: string;
  idempotencyKey: string;
  assessmentReference: string;
  repository: string;
  pullRequestNumber: number;
  expectedHeadSha: string;
  patchDigest: string;
  createdAt: string;
  created: boolean;
}

export interface CommitAuditView {
  intentId: string;
  assessmentReference: string;
  repository: string;
  pullRequestNumber: number;
  expectedHeadSha: string;
  patchDigest: string;
  actorSubject: string;
  approvedAt: string;
  requestedAt: string;
  outcome: 'pending' | 'succeeded' | 'failed';
  commitSha: string | null;
  errorCode: string | null;
  occurredAt: string | null;
}

export type PersistenceErrorCode =
  | 'not_found'
  | 'conflict'
  | 'invalid_oauth_attempt'
  | 'idempotency_conflict'
  | 'invalid_record';

export class PersistenceError extends Error {
  override readonly name = 'PersistenceError';

  constructor(readonly code: PersistenceErrorCode) {
    super(persistenceMessage(code));
  }
}

const GitHubConnectionRowSchema = z.object({
  github_user_id: z.string(),
  github_login: z.string(),
  github_display_name: z.string().nullable(),
  token_expires_at: TimestampSchema.nullable(),
  connected_at: TimestampSchema,
  updated_at: TimestampSchema,
});

const GitHubCredentialRowSchema = z.object({ encrypted_credentials: z.unknown() });

const OmnigentSessionRowSchema = z.object({
  id: UuidSchema,
  provider_session_id: z.string().max(512).nullable(),
  assessment_reference: AssessmentReferenceSchema,
  expected_head_sha: CommitShaSchema,
  authorized_evidence_digest: PatchDigestSchema,
  guidance: z.string().nullable(),
  status: OmnigentSessionStatusSchema,
  status_message: z.string().nullable(),
  cancel_requested_at: TimestampSchema.nullable(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  finished_at: TimestampSchema.nullable(),
});

const ValidatedPatchRowSchema = z.object({
  id: UuidSchema,
  session_id: UuidSchema,
  expected_head_sha: CommitShaSchema,
  patch_digest: PatchDigestSchema,
  changed_files: z.unknown(),
  created_at: TimestampSchema,
});

const DecryptedPatchRowSchema = ValidatedPatchRowSchema.extend({
  expected_files: z.unknown(),
  encrypted_patch: z.unknown(),
});

const ApprovalRowSchema = z.object({
  id: UuidSchema,
  session_id: UuidSchema,
  patch_id: UuidSchema,
  expected_head_sha: CommitShaSchema,
  patch_digest: PatchDigestSchema,
  approved_at: TimestampSchema,
  created: z.boolean(),
});

const CommitIntentRowSchema = z.object({
  id: UuidSchema,
  approval_id: UuidSchema,
  idempotency_key: z.string(),
  assessment_reference: AssessmentReferenceSchema,
  repository: GitHubRepositorySchema,
  pull_request_number: z.coerce.number().int().positive(),
  expected_head_sha: CommitShaSchema,
  patch_digest: PatchDigestSchema,
  created_at: TimestampSchema,
  created: z.boolean(),
});

const CommitAuditRowSchema = z.object({
  intent_id: UuidSchema,
  assessment_reference: AssessmentReferenceSchema,
  repository: GitHubRepositorySchema,
  pull_request_number: z.coerce.number().int().positive(),
  expected_head_sha: CommitShaSchema,
  patch_digest: PatchDigestSchema,
  actor_subject: ActorSchema,
  approved_at: TimestampSchema,
  requested_at: TimestampSchema,
  outcome: z.enum(['succeeded', 'failed']).nullable(),
  commit_sha: CommitShaSchema.nullable(),
  error_code: z.string().nullable(),
  occurred_at: TimestampSchema.nullable(),
});

export class LineageImpactRepository {
  constructor(
    private readonly executor: QueryExecutor,
    private readonly cipher: Aes256GcmCipher
  ) {}

  async createOAuthAttempt(input: { actorSubject: string; record: OAuthAttemptRecord }): Promise<void> {
    const actor = ActorSchema.parse(input.actorSubject);
    const record = OAuthAttemptRecordSchema.parse(input.record);
    const result = await this.executor.query(
      `INSERT INTO lineage_impact.oauth_attempts (
        state_hash, actor_subject, binding_hash, pkce_verifier, created_at, expires_at, consumed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NULL)
      ON CONFLICT (state_hash) DO NOTHING
      RETURNING state_hash`,
      [record.stateDigest, actor, record.bindingDigest, record.codeVerifier, record.createdAt, record.expiresAt]
    );
    if (result.rows.length !== 1) throw new PersistenceError('conflict');
  }

  /** Atomically consumes one unexpired OAuth state without ever storing the raw state. */
  async consumeOAuthAttempt(input: {
    actorSubject: string;
    submittedState: string;
    binding: string;
    now?: Date;
  }): Promise<{ codeVerifier: string }> {
    const actor = ActorSchema.parse(input.actorSubject);
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.submittedState) || !isValidBinding(input.binding)) {
      throw new PersistenceError('invalid_oauth_attempt');
    }
    const now = validateDate(input.now ?? new Date());
    const result = await this.executor.query(
      `UPDATE lineage_impact.oauth_attempts
       SET consumed_at = $4
       WHERE state_hash = $1
         AND actor_subject = $2
         AND binding_hash = $3
         AND consumed_at IS NULL
         AND created_at <= $4
         AND expires_at > $4
       RETURNING pkce_verifier`,
      [sha256Hex(input.submittedState), actor, sha256Hex(input.binding), now.toISOString()]
    );
    const parsed = z.object({ pkce_verifier: z.string().min(43).max(128) }).safeParse(result.rows[0]);
    if (!parsed.success) throw new PersistenceError('invalid_oauth_attempt');
    return { codeVerifier: parsed.data.pkce_verifier };
  }

  async saveGitHubConnection(input: {
    actorSubject: string;
    identity: GitHubIdentity;
    credential: GitHubUserCredential;
    now?: Date;
  }): Promise<GitHubConnectionStatus> {
    const actor = ActorSchema.parse(input.actorSubject);
    const identity = GitHubIdentitySchema.parse(input.identity);
    const credential = GitHubUserCredentialSchema.parse(input.credential);
    const now = validateDate(input.now ?? new Date()).toISOString();
    const encrypted = this.cipher.seal(JSON.stringify(credential), githubCredentialAssociatedData(actor));
    const result = await this.executor.query(
      `INSERT INTO lineage_impact.github_connections (
        actor_subject, github_user_id, github_login, github_display_name,
        encrypted_credentials, token_expires_at, connected_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
      ON CONFLICT (actor_subject) DO UPDATE SET
        github_user_id = EXCLUDED.github_user_id,
        github_login = EXCLUDED.github_login,
        github_display_name = EXCLUDED.github_display_name,
        encrypted_credentials = EXCLUDED.encrypted_credentials,
        token_expires_at = EXCLUDED.token_expires_at,
        connected_at = EXCLUDED.connected_at,
        updated_at = EXCLUDED.updated_at
      RETURNING github_user_id, github_login, github_display_name,
        token_expires_at, connected_at, updated_at`,
      [actor, identity.id, identity.login, identity.displayName, encrypted, credential.expiresAt, now]
    );
    return mapConnectionStatus(parseSingleRow(GitHubConnectionRowSchema, result.rows));
  }

  async getGitHubConnectionStatus(actorSubject: string): Promise<GitHubConnectionStatus> {
    const actor = ActorSchema.parse(actorSubject);
    const result = await this.executor.query(
      `SELECT github_user_id, github_login, github_display_name,
        token_expires_at, connected_at, updated_at
       FROM lineage_impact.github_connections
       WHERE actor_subject = $1`,
      [actor]
    );
    if (result.rows.length === 0) return { connected: false };
    return mapConnectionStatus(parseSingleRow(GitHubConnectionRowSchema, result.rows));
  }

  /** Server-only credential retrieval. The encrypted database value is never returned. */
  async loadGitHubCredential(actorSubject: string): Promise<GitHubUserCredential | null> {
    const actor = ActorSchema.parse(actorSubject);
    const result = await this.executor.query(
      `SELECT encrypted_credentials
       FROM lineage_impact.github_connections
       WHERE actor_subject = $1`,
      [actor]
    );
    if (result.rows.length === 0) return null;
    const row = parseSingleRow(GitHubCredentialRowSchema, result.rows);
    const plaintext = this.cipher.openText(
      parseJsonColumn(row.encrypted_credentials),
      githubCredentialAssociatedData(actor)
    );
    return GitHubUserCredentialSchema.parse(parseJsonText(plaintext));
  }

  async disconnectGitHub(actorSubject: string): Promise<boolean> {
    const actor = ActorSchema.parse(actorSubject);
    const result = await this.executor.query(
      `DELETE FROM lineage_impact.github_connections
       WHERE actor_subject = $1
       RETURNING actor_subject`,
      [actor]
    );
    return result.rows.length === 1;
  }

  async createOmnigentSession(input: {
    actorSubject: string;
    assessmentReference: string;
    expectedHeadSha: string;
    authorizedEvidenceDigest: string;
    guidance?: string | null;
    now?: Date;
  }): Promise<OmnigentSessionView> {
    const actor = ActorSchema.parse(input.actorSubject);
    const reference = AssessmentReferenceSchema.parse(input.assessmentReference);
    const expectedHeadSha = CommitShaSchema.parse(input.expectedHeadSha);
    const evidenceDigest = PatchDigestSchema.parse(input.authorizedEvidenceDigest);
    const guidance = nullableGuidance(input.guidance);
    const id = randomUUID();
    const now = validateDate(input.now ?? new Date()).toISOString();
    const result = await this.executor.query(
      `INSERT INTO lineage_impact.omnigent_sessions (
        id, actor_subject, assessment_reference, expected_head_sha,
        authorized_evidence_digest, guidance, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $7)
      RETURNING id, provider_session_id, assessment_reference, expected_head_sha, authorized_evidence_digest,
        guidance, status, status_message, cancel_requested_at, created_at, updated_at, finished_at`,
      [id, actor, reference, expectedHeadSha, evidenceDigest, guidance, now]
    );
    return mapOmnigentSession(parseSingleRow(OmnigentSessionRowSchema, result.rows));
  }

  async getOmnigentSession(actorSubject: string, sessionId: string): Promise<OmnigentSessionView | null> {
    const actor = ActorSchema.parse(actorSubject);
    const id = UuidSchema.parse(sessionId);
    const result = await this.executor.query(
      `SELECT id, provider_session_id, assessment_reference, expected_head_sha, authorized_evidence_digest,
        guidance, status, status_message, cancel_requested_at, created_at, updated_at, finished_at
       FROM lineage_impact.omnigent_sessions
       WHERE actor_subject = $1 AND id = $2`,
      [actor, id]
    );
    if (result.rows.length === 0) return null;
    return mapOmnigentSession(parseSingleRow(OmnigentSessionRowSchema, result.rows));
  }

  async transitionOmnigentSession(input: {
    actorSubject: string;
    sessionId: string;
    expectedStatuses: OmnigentSessionStatus[];
    status: OmnigentSessionStatus;
    statusMessage?: string | null;
    providerSessionId?: string | null;
    now?: Date;
  }): Promise<OmnigentSessionView> {
    const actor = ActorSchema.parse(input.actorSubject);
    const id = UuidSchema.parse(input.sessionId);
    const expectedStatuses = z.array(OmnigentSessionStatusSchema).min(1).parse(input.expectedStatuses);
    const status = OmnigentSessionStatusSchema.parse(input.status);
    const statusMessage = nullableShortText(input.statusMessage, 1000);
    const providerSessionId = nullableShortText(input.providerSessionId, 512);
    const now = validateDate(input.now ?? new Date()).toISOString();
    const terminal = status === 'complete' || status === 'failed' || status === 'cancelled';
    const result = await this.executor.query(
      `UPDATE lineage_impact.omnigent_sessions
       SET status = $4,
           status_message = $5,
           provider_session_id = COALESCE($6, provider_session_id),
           updated_at = $7,
           finished_at = CASE WHEN $8 THEN $7 ELSE finished_at END
       WHERE actor_subject = $1 AND id = $2 AND status = ANY($3::text[])
       RETURNING id, provider_session_id, assessment_reference, expected_head_sha, authorized_evidence_digest,
         guidance, status, status_message, cancel_requested_at, created_at, updated_at, finished_at`,
      [actor, id, expectedStatuses, status, statusMessage, providerSessionId, now, terminal]
    );
    if (result.rows.length !== 1) throw new PersistenceError('conflict');
    return mapOmnigentSession(parseSingleRow(OmnigentSessionRowSchema, result.rows));
  }

  async requestOmnigentCancellation(input: {
    actorSubject: string;
    sessionId: string;
    now?: Date;
  }): Promise<OmnigentSessionView> {
    const actor = ActorSchema.parse(input.actorSubject);
    const id = UuidSchema.parse(input.sessionId);
    const now = validateDate(input.now ?? new Date()).toISOString();
    const result = await this.executor.query(
      `UPDATE lineage_impact.omnigent_sessions
       SET status = 'cancelled', cancel_requested_at = $3, updated_at = $3, finished_at = $3
       WHERE actor_subject = $1 AND id = $2 AND status IN ('queued', 'running', 'validating')
       RETURNING id, provider_session_id, assessment_reference, expected_head_sha, authorized_evidence_digest,
         guidance, status, status_message, cancel_requested_at, created_at, updated_at, finished_at`,
      [actor, id, now]
    );
    if (result.rows.length !== 1) throw new PersistenceError('conflict');
    return mapOmnigentSession(parseSingleRow(OmnigentSessionRowSchema, result.rows));
  }

  async storeValidatedPatch(input: {
    actorSubject: string;
    sessionId: string;
    patch: ValidatedPatch;
    expectedFiles: PersistedExpectedFileVersion[];
    now?: Date;
  }): Promise<ValidatedPatchMetadata> {
    const actor = ActorSchema.parse(input.actorSubject);
    const sessionId = UuidSchema.parse(input.sessionId);
    let validatedPatch: ValidatedPatch;
    try {
      validatedPatch = validatePatchCandidate({
        gate: input.patch.gate,
        files: input.patch.files,
        patch: input.patch.bytes,
      });
    } catch {
      throw new PersistenceError('invalid_record');
    }
    const expectedHeadSha = CommitShaSchema.parse(validatedPatch.gate.expectedHeadSha);
    const patchDigest = PatchDigestSchema.parse(validatedPatch.digest);
    if (input.patch.digest !== patchDigest || computePatchDigest(validatedPatch.bytes) !== patchDigest) {
      throw new PersistenceError('invalid_record');
    }
    const files = z.array(ChangedFileDescriptorSchema).min(1).max(50).parse(validatedPatch.files);
    const expectedFiles = bindPersistedExpectedFiles(input.expectedFiles, files);
    const id = randomUUID();
    const encryptedPatch = this.cipher.seal(validatedPatch.bytes, patchAssociatedData(actor, id));
    const now = validateDate(input.now ?? new Date()).toISOString();
    const result = await this.executor.query(
      `INSERT INTO lineage_impact.validated_patches (
        id, actor_subject, session_id, expected_head_sha, patch_digest,
        changed_files, expected_files, encrypted_patch, created_at
      )
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
      FROM lineage_impact.omnigent_sessions
      WHERE actor_subject = $2 AND id = $3 AND expected_head_sha = $4 AND status <> 'cancelled'
      ON CONFLICT (actor_subject, session_id) DO NOTHING
      RETURNING id, session_id, expected_head_sha, patch_digest, changed_files, created_at`,
      [
        id,
        actor,
        sessionId,
        expectedHeadSha,
        patchDigest,
        JSON.stringify(files),
        JSON.stringify(expectedFiles),
        encryptedPatch,
        now,
      ]
    );
    if (result.rows.length !== 1) throw new PersistenceError('conflict');
    return mapPatchMetadata(parseSingleRow(ValidatedPatchRowSchema, result.rows));
  }

  async getValidatedPatchMetadata(actorSubject: string, patchId: string): Promise<ValidatedPatchMetadata | null> {
    const actor = ActorSchema.parse(actorSubject);
    const id = UuidSchema.parse(patchId);
    const result = await this.executor.query(
      `SELECT id, session_id, expected_head_sha, patch_digest, changed_files, created_at
       FROM lineage_impact.validated_patches
       WHERE actor_subject = $1 AND id = $2`,
      [actor, id]
    );
    if (result.rows.length === 0) return null;
    return mapPatchMetadata(parseSingleRow(ValidatedPatchRowSchema, result.rows));
  }

  async getValidatedPatchMetadataForSession(
    actorSubject: string,
    sessionId: string
  ): Promise<ValidatedPatchMetadata | null> {
    const actor = ActorSchema.parse(actorSubject);
    const id = UuidSchema.parse(sessionId);
    const result = await this.executor.query(
      `SELECT id, session_id, expected_head_sha, patch_digest, changed_files, created_at
       FROM lineage_impact.validated_patches
       WHERE actor_subject = $1 AND session_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [actor, id]
    );
    if (result.rows.length === 0) return null;
    return mapPatchMetadata(parseSingleRow(ValidatedPatchRowSchema, result.rows));
  }

  /** Server-only patch retrieval. This decrypts in memory and never exposes ciphertext. */
  async loadDecryptedValidatedPatch(actorSubject: string, patchId: string): Promise<DecryptedValidatedPatch | null> {
    const actor = ActorSchema.parse(actorSubject);
    const id = UuidSchema.parse(patchId);
    const result = await this.executor.query(
      `SELECT id, session_id, expected_head_sha, patch_digest,
        changed_files, expected_files, encrypted_patch, created_at
       FROM lineage_impact.validated_patches
       WHERE actor_subject = $1 AND id = $2`,
      [actor, id]
    );
    if (result.rows.length === 0) return null;
    const row = parseSingleRow(DecryptedPatchRowSchema, result.rows);
    const metadata = mapPatchMetadata(row);
    const bytes = this.cipher.open(parseJsonColumn(row.encrypted_patch), patchAssociatedData(actor, id));
    if (computePatchDigest(bytes) !== metadata.patchDigest) throw new PersistenceError('invalid_record');
    const expectedFiles = parsePersistedExpectedFiles(row.expected_files, metadata.files);
    return { ...metadata, bytes, expectedFiles };
  }

  /** Server-only session lookup used by `/fix-sessions/:id/patch`. */
  async loadDecryptedValidatedPatchForSession(
    actorSubject: string,
    sessionId: string
  ): Promise<DecryptedValidatedPatch | null> {
    const actor = ActorSchema.parse(actorSubject);
    const id = UuidSchema.parse(sessionId);
    const result = await this.executor.query(
      `SELECT id, session_id, expected_head_sha, patch_digest,
        changed_files, expected_files, encrypted_patch, created_at
       FROM lineage_impact.validated_patches
       WHERE actor_subject = $1 AND session_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [actor, id]
    );
    if (result.rows.length === 0) return null;
    const row = parseSingleRow(DecryptedPatchRowSchema, result.rows);
    const metadata = mapPatchMetadata(row);
    const bytes = this.cipher.open(parseJsonColumn(row.encrypted_patch), patchAssociatedData(actor, metadata.id));
    if (computePatchDigest(bytes) !== metadata.patchDigest) throw new PersistenceError('invalid_record');
    const expectedFiles = parsePersistedExpectedFiles(row.expected_files, metadata.files);
    return { ...metadata, bytes, expectedFiles };
  }

  async approvePatch(input: {
    actorSubject: string;
    sessionId: string;
    expectedHeadSha: string;
    patchDigest: string;
    now?: Date;
  }): Promise<PatchApprovalView> {
    const actor = ActorSchema.parse(input.actorSubject);
    const sessionId = UuidSchema.parse(input.sessionId);
    const expectedHeadSha = CommitShaSchema.parse(input.expectedHeadSha);
    const patchDigest = PatchDigestSchema.parse(input.patchDigest);
    const id = randomUUID();
    const now = validateDate(input.now ?? new Date()).toISOString();
    const result = await this.executor.query(
      `WITH matching_patch AS (
         SELECT id
         FROM lineage_impact.validated_patches
         WHERE actor_subject = $1 AND session_id = $2
           AND expected_head_sha = $3 AND patch_digest = $4
         ORDER BY created_at DESC
         LIMIT 1
       ), inserted AS (
         INSERT INTO lineage_impact.patch_approvals (
           id, actor_subject, session_id, patch_id, expected_head_sha, patch_digest, approved_at
         )
         SELECT $5, $1, $2, matching_patch.id, $3, $4, $6 FROM matching_patch
         ON CONFLICT (actor_subject, session_id, expected_head_sha, patch_digest) DO NOTHING
         RETURNING id, session_id, patch_id, expected_head_sha, patch_digest, approved_at, TRUE AS created
       )
       SELECT * FROM inserted
       UNION ALL
       SELECT id, session_id, patch_id, expected_head_sha, patch_digest, approved_at, FALSE AS created
       FROM lineage_impact.patch_approvals
       WHERE actor_subject = $1 AND session_id = $2
         AND expected_head_sha = $3 AND patch_digest = $4
         AND NOT EXISTS (SELECT 1 FROM inserted)
       LIMIT 1`,
      [actor, sessionId, expectedHeadSha, patchDigest, id, now]
    );
    if (result.rows.length !== 1) throw new PersistenceError('not_found');
    return mapApproval(parseSingleRow(ApprovalRowSchema, result.rows));
  }

  /** Existing-only approval lookup; commit flows must never create approval implicitly. */
  async getPatchApproval(
    actorSubject: string,
    sessionId: string,
    expectedHeadSha: string,
    patchDigest: string
  ): Promise<PatchApprovalView | null> {
    const actor = ActorSchema.parse(actorSubject);
    const session = UuidSchema.parse(sessionId);
    const head = CommitShaSchema.parse(expectedHeadSha);
    const digest = PatchDigestSchema.parse(patchDigest);
    const result = await this.executor.query(
      `SELECT id, session_id, patch_id, expected_head_sha, patch_digest,
         approved_at, FALSE AS created
       FROM lineage_impact.patch_approvals
       WHERE actor_subject = $1 AND session_id = $2
         AND expected_head_sha = $3 AND patch_digest = $4`,
      [actor, session, head, digest]
    );
    if (result.rows.length === 0) return null;
    return mapApproval(parseSingleRow(ApprovalRowSchema, result.rows));
  }

  /**
   * Reserves one immutable commit intent. Only callers receiving `created: true`
   * may mutate GitHub; an existing reservation must be reconciled, not replayed.
   */
  async reserveCommit(input: {
    actorSubject: string;
    approvalId: string;
    idempotencyKey: string;
    assessmentReference: string;
    repository: string;
    pullRequestNumber: number;
    expectedHeadSha: string;
    patchDigest: string;
    now?: Date;
  }): Promise<CommitIntentView> {
    const actor = ActorSchema.parse(input.actorSubject);
    const approvalId = UuidSchema.parse(input.approvalId);
    if (!IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) throw new PersistenceError('invalid_record');
    const reference = AssessmentReferenceSchema.parse(input.assessmentReference);
    const repository = GitHubRepositorySchema.parse(input.repository);
    const pullRequestNumber = z.number().int().positive().parse(input.pullRequestNumber);
    const expectedHeadSha = CommitShaSchema.parse(input.expectedHeadSha);
    const patchDigest = PatchDigestSchema.parse(input.patchDigest);
    const id = randomUUID();
    const now = validateDate(input.now ?? new Date()).toISOString();
    const result = await this.executor.query(
      `WITH eligible AS (
         SELECT approvals.id
         FROM lineage_impact.patch_approvals AS approvals
         JOIN lineage_impact.validated_patches AS patches
           ON patches.actor_subject = approvals.actor_subject AND patches.id = approvals.patch_id
         JOIN lineage_impact.omnigent_sessions AS sessions
           ON sessions.actor_subject = approvals.actor_subject AND sessions.id = approvals.session_id
         WHERE approvals.actor_subject = $1 AND approvals.id = $2
           AND approvals.expected_head_sha = $7 AND approvals.patch_digest = $8
           AND sessions.assessment_reference = $4
       ), inserted AS (
         INSERT INTO lineage_impact.commit_intents (
           id, actor_subject, approval_id, idempotency_key, assessment_reference,
           repository, pull_request_number, expected_head_sha, patch_digest, created_at
         )
         SELECT $9, $1, eligible.id, $3, $4, $5, $6, $7, $8, $10 FROM eligible
         ON CONFLICT (actor_subject, idempotency_key) DO NOTHING
         RETURNING id, approval_id, idempotency_key, assessment_reference, repository,
           pull_request_number, expected_head_sha, patch_digest, created_at, TRUE AS created
       )
       SELECT * FROM inserted
       UNION ALL
       SELECT id, approval_id, idempotency_key, assessment_reference, repository,
         pull_request_number, expected_head_sha, patch_digest, created_at, FALSE AS created
       FROM lineage_impact.commit_intents
       WHERE actor_subject = $1 AND idempotency_key = $3
         AND NOT EXISTS (SELECT 1 FROM inserted)
       LIMIT 1`,
      [
        actor,
        approvalId,
        input.idempotencyKey,
        reference,
        repository,
        pullRequestNumber,
        expectedHeadSha,
        patchDigest,
        id,
        now,
      ]
    );
    if (result.rows.length !== 1) throw new PersistenceError('not_found');
    const intent = mapCommitIntent(parseSingleRow(CommitIntentRowSchema, result.rows));
    if (
      intent.approvalId !== approvalId ||
      intent.assessmentReference !== reference ||
      intent.repository.toLowerCase() !== repository.toLowerCase() ||
      intent.pullRequestNumber !== pullRequestNumber ||
      intent.expectedHeadSha !== expectedHeadSha ||
      intent.patchDigest !== patchDigest
    ) {
      throw new PersistenceError('idempotency_conflict');
    }
    return intent;
  }

  async appendCommitAuditEvent(input: {
    actorSubject: string;
    intentId: string;
    outcome: 'succeeded' | 'failed';
    commitSha?: string | null;
    errorCode?: string | null;
    now?: Date;
  }): Promise<{ created: boolean; outcome: 'succeeded' | 'failed'; occurredAt: string }> {
    const actor = ActorSchema.parse(input.actorSubject);
    const intentId = UuidSchema.parse(input.intentId);
    const outcome = z.enum(['succeeded', 'failed']).parse(input.outcome);
    const commitSha = input.commitSha == null ? null : CommitShaSchema.parse(input.commitSha);
    const errorCode = input.errorCode == null ? null : input.errorCode;
    if (
      (outcome === 'succeeded' && (commitSha === null || errorCode !== null)) ||
      (outcome === 'failed' && (commitSha !== null || errorCode === null || !SAFE_ERROR_CODE_PATTERN.test(errorCode)))
    ) {
      throw new PersistenceError('invalid_record');
    }
    const id = randomUUID();
    const now = validateDate(input.now ?? new Date()).toISOString();
    const result = await this.executor.query(
      `WITH inserted AS (
         INSERT INTO lineage_impact.commit_audit_events (
           id, intent_id, actor_subject, outcome, commit_sha, error_code, occurred_at
         )
         SELECT $3, id, actor_subject, $4, $5, $6, $7
         FROM lineage_impact.commit_intents
         WHERE actor_subject = $1 AND id = $2
         ON CONFLICT DO NOTHING
         RETURNING outcome, occurred_at, TRUE AS created
       )
       SELECT * FROM inserted
       UNION ALL
       SELECT outcome, occurred_at, FALSE AS created
       FROM lineage_impact.commit_audit_events
       WHERE actor_subject = $1 AND intent_id = $2 AND outcome = 'succeeded' AND $4 = 'succeeded'
         AND NOT EXISTS (SELECT 1 FROM inserted)
       LIMIT 1`,
      [actor, intentId, id, outcome, commitSha, errorCode, now]
    );
    const parsed = parseSingleRow(
      z.object({ outcome: z.enum(['succeeded', 'failed']), occurred_at: TimestampSchema, created: z.boolean() }),
      result.rows
    );
    return { created: parsed.created, outcome: parsed.outcome, occurredAt: parsed.occurred_at };
  }

  async listCommitAudit(actorSubject: string, assessmentReference: string): Promise<CommitAuditView[]> {
    const actor = ActorSchema.parse(actorSubject);
    const reference = AssessmentReferenceSchema.parse(assessmentReference);
    const result = await this.executor.query(
      `SELECT intents.id AS intent_id, intents.assessment_reference, intents.repository,
         intents.pull_request_number, intents.expected_head_sha, intents.patch_digest,
         intents.actor_subject, approvals.approved_at,
         intents.created_at AS requested_at,
         events.outcome, events.commit_sha, events.error_code, events.occurred_at
       FROM lineage_impact.commit_intents AS intents
       JOIN lineage_impact.patch_approvals AS approvals
         ON approvals.actor_subject = intents.actor_subject AND approvals.id = intents.approval_id
       LEFT JOIN lineage_impact.commit_audit_events AS events
         ON events.actor_subject = intents.actor_subject AND events.intent_id = intents.id
       WHERE intents.actor_subject = $1 AND intents.assessment_reference = $2
       ORDER BY intents.created_at DESC, events.occurred_at DESC NULLS LAST`,
      [actor, reference]
    );
    return result.rows.map((row) => mapCommitAudit(CommitAuditRowSchema.parse(row)));
  }
}

function mapConnectionStatus(row: z.infer<typeof GitHubConnectionRowSchema>): GitHubConnectionStatus {
  return {
    connected: true,
    identity: {
      id: row.github_user_id,
      login: row.github_login,
      displayName: row.github_display_name,
    },
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
    expiresAt: row.token_expires_at,
  };
}

function mapOmnigentSession(row: z.infer<typeof OmnigentSessionRowSchema>): OmnigentSessionView {
  return {
    id: row.id,
    providerSessionId: row.provider_session_id,
    assessmentReference: row.assessment_reference,
    expectedHeadSha: row.expected_head_sha,
    authorizedEvidenceDigest: row.authorized_evidence_digest,
    guidance: row.guidance,
    status: row.status,
    statusMessage: row.status_message,
    cancelRequestedAt: row.cancel_requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function mapPatchMetadata(row: z.infer<typeof ValidatedPatchRowSchema>): ValidatedPatchMetadata {
  return {
    id: row.id,
    sessionId: row.session_id,
    expectedHeadSha: row.expected_head_sha,
    patchDigest: row.patch_digest,
    files: z.array(ChangedFileDescriptorSchema).min(1).max(50).parse(parseJsonColumn(row.changed_files)),
    createdAt: row.created_at,
  };
}

function parsePersistedExpectedFiles(
  value: unknown,
  descriptors: ChangedFileDescriptor[]
): PersistedExpectedFileVersion[] {
  return bindPersistedExpectedFiles(
    z.array(PersistedExpectedFileVersionSchema).min(1).max(50).parse(parseJsonColumn(value)),
    descriptors
  );
}

function bindPersistedExpectedFiles(
  rawExpectedFiles: PersistedExpectedFileVersion[],
  descriptors: ChangedFileDescriptor[]
): PersistedExpectedFileVersion[] {
  const expectedFiles = z.array(PersistedExpectedFileVersionSchema).min(1).max(50).parse(rawExpectedFiles);
  const expectedByPath = new Map(expectedFiles.map((file) => [file.path, file]));
  if (expectedByPath.size !== expectedFiles.length || expectedFiles.length !== descriptors.length) {
    throw new PersistenceError('invalid_record');
  }
  const bound: PersistedExpectedFileVersion[] = [];
  for (const descriptor of descriptors) {
    if (
      descriptor.beforePath !== null &&
      descriptor.afterPath !== null &&
      descriptor.beforePath !== descriptor.afterPath
    ) {
      throw new PersistenceError('invalid_record');
    }
    const path = descriptor.afterPath ?? descriptor.beforePath;
    if (path === null) throw new PersistenceError('invalid_record');
    const expected = expectedByPath.get(path);
    if (expected === undefined || (descriptor.beforePath === null) !== (expected.expectedBlobSha === null)) {
      throw new PersistenceError('invalid_record');
    }
    bound.push(expected);
  }
  return bound;
}

function mapApproval(row: z.infer<typeof ApprovalRowSchema>): PatchApprovalView {
  return {
    id: row.id,
    sessionId: row.session_id,
    patchId: row.patch_id,
    expectedHeadSha: row.expected_head_sha,
    patchDigest: row.patch_digest,
    approvedAt: row.approved_at,
    created: row.created,
  };
}

function mapCommitIntent(row: z.infer<typeof CommitIntentRowSchema>): CommitIntentView {
  return {
    id: row.id,
    approvalId: row.approval_id,
    idempotencyKey: row.idempotency_key,
    assessmentReference: row.assessment_reference,
    repository: row.repository,
    pullRequestNumber: row.pull_request_number,
    expectedHeadSha: row.expected_head_sha,
    patchDigest: row.patch_digest,
    createdAt: row.created_at,
    created: row.created,
  };
}

function mapCommitAudit(row: z.infer<typeof CommitAuditRowSchema>): CommitAuditView {
  return {
    intentId: row.intent_id,
    assessmentReference: row.assessment_reference,
    repository: row.repository,
    pullRequestNumber: row.pull_request_number,
    expectedHeadSha: row.expected_head_sha,
    patchDigest: row.patch_digest,
    actorSubject: row.actor_subject,
    approvedAt: row.approved_at,
    requestedAt: row.requested_at,
    outcome: row.outcome ?? 'pending',
    commitSha: row.commit_sha,
    errorCode: row.error_code,
    occurredAt: row.occurred_at,
  };
}

function parseSingleRow<T>(schema: z.ZodType<T>, rows: Record<string, unknown>[]): T {
  if (rows.length !== 1) throw new PersistenceError('invalid_record');
  const parsed = schema.safeParse(rows[0]);
  if (!parsed.success) throw new PersistenceError('invalid_record');
  return parsed.data;
}

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return parseJsonText(value);
}

function parseJsonText(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new PersistenceError('invalid_record');
  }
}

function nullableGuidance(value: string | null | undefined): string | null {
  if (value == null) return null;
  return z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .refine((candidate) => !hasControlCharacter(candidate), 'Invalid guidance')
    .parse(value);
}

function nullableShortText(value: string | null | undefined, maxLength: number): string | null {
  if (value == null) return null;
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((candidate) => !hasControlCharacter(candidate), 'Invalid text')
    .parse(value);
}

function githubCredentialAssociatedData(actor: string): string {
  return `github-credential:v1:${actor}`;
}

function patchAssociatedData(actor: string, patchId: string): string {
  return `validated-patch:v1:${actor}:${patchId}`;
}

function sha256Hex(value: string): string {
  return HashSchema.parse(createHash('sha256').update(value, 'utf8').digest('hex'));
}

function validateDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new PersistenceError('invalid_record');
  return value;
}

function isValidBinding(value: string): boolean {
  return typeof value === 'string' && value.length >= 32 && value.length <= 512;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function persistenceMessage(code: PersistenceErrorCode): string {
  switch (code) {
    case 'not_found':
      return 'Requested record was not found';
    case 'conflict':
      return 'Record could not be changed in its current state';
    case 'invalid_oauth_attempt':
      return 'OAuth authorization attempt is not valid';
    case 'idempotency_conflict':
      return 'Idempotency key was already used for a different request';
    case 'invalid_record':
      return 'Stored record is invalid';
  }
}
