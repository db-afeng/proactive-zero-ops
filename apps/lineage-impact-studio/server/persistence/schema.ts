/**
 * Lakebase bootstrap statements for the app-owned schema.
 *
 * This module deliberately has no import-time side effects. The deployed app
 * service principal must call `bootstrapLineageImpactStore` from AppKit's
 * `onPluginsReady` hook so that it, rather than a developer's local identity,
 * owns the schema.
 */
export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount?: number | null;
}

/** The small subset of the AppKit Lakebase handle used by persistence code. */
export interface QueryExecutor {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
}

export const LINEAGE_IMPACT_SCHEMA = 'lineage_impact';

export const LINEAGE_IMPACT_BOOTSTRAP_SQL = Object.freeze([
  `CREATE SCHEMA IF NOT EXISTS lineage_impact`,
  `CREATE TABLE IF NOT EXISTS lineage_impact.oauth_attempts (
    state_hash CHAR(64) PRIMARY KEY,
    actor_subject TEXT NOT NULL,
    binding_hash CHAR(64) NOT NULL,
    pkce_verifier TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    CONSTRAINT oauth_state_hash_format CHECK (state_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT oauth_binding_hash_format CHECK (binding_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT oauth_pkce_verifier_length CHECK (char_length(pkce_verifier) BETWEEN 43 AND 128),
    CONSTRAINT oauth_expiry_order CHECK (expires_at > created_at),
    CONSTRAINT oauth_consumption_order CHECK (
      consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at < expires_at)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS oauth_attempts_actor_expiry_idx
    ON lineage_impact.oauth_attempts (actor_subject, expires_at DESC)`,
  `CREATE TABLE IF NOT EXISTS lineage_impact.github_connections (
    actor_subject TEXT PRIMARY KEY,
    github_user_id TEXT NOT NULL,
    github_login TEXT NOT NULL,
    github_display_name TEXT,
    encrypted_credentials JSONB NOT NULL,
    token_expires_at TIMESTAMPTZ,
    connected_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS lineage_impact.databricks_fix_authorizations (
    actor_subject TEXT PRIMARY KEY,
    encrypted_access_token JSONB NOT NULL,
    token_expires_at TIMESTAMPTZ NOT NULL,
    connected_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS lineage_impact.omnigent_sessions (
    id UUID PRIMARY KEY,
    actor_subject TEXT NOT NULL,
    assessment_reference TEXT NOT NULL,
    expected_head_sha TEXT NOT NULL,
    authorized_evidence_digest TEXT NOT NULL,
    guidance TEXT,
    provider_session_id TEXT,
    git_credential_id BIGINT,
    status TEXT NOT NULL,
    status_message TEXT,
    cancel_requested_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    CONSTRAINT omnigent_session_actor_id_unique UNIQUE (actor_subject, id),
    CONSTRAINT omnigent_session_status CHECK (
      status IN ('queued', 'running', 'validating', 'complete', 'failed', 'cancelled')
    ),
    CONSTRAINT omnigent_expected_head_sha CHECK (expected_head_sha ~ '^[0-9a-f]{40,64}$'),
    CONSTRAINT omnigent_evidence_digest CHECK (authorized_evidence_digest ~ '^sha256:[0-9a-f]{64}$')
  )`,
  `ALTER TABLE lineage_impact.omnigent_sessions
    ADD COLUMN IF NOT EXISTS provider_session_id TEXT`,
  `ALTER TABLE lineage_impact.omnigent_sessions
    ADD COLUMN IF NOT EXISTS git_credential_id BIGINT`,
  `CREATE INDEX IF NOT EXISTS omnigent_sessions_actor_assessment_idx
    ON lineage_impact.omnigent_sessions (actor_subject, assessment_reference, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS lineage_impact.validated_patches (
    id UUID PRIMARY KEY,
    actor_subject TEXT NOT NULL,
    session_id UUID NOT NULL,
    expected_head_sha TEXT NOT NULL,
    patch_digest TEXT NOT NULL,
    changed_files JSONB NOT NULL,
    expected_files JSONB NOT NULL,
    encrypted_patch JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT validated_patch_actor_id_unique UNIQUE (actor_subject, id),
    CONSTRAINT validated_patch_session_unique UNIQUE (actor_subject, session_id),
    CONSTRAINT validated_patch_session_fk FOREIGN KEY (actor_subject, session_id)
      REFERENCES lineage_impact.omnigent_sessions (actor_subject, id),
    CONSTRAINT validated_patch_expected_head_sha CHECK (expected_head_sha ~ '^[0-9a-f]{40,64}$'),
    CONSTRAINT validated_patch_digest CHECK (patch_digest ~ '^sha256:[0-9a-f]{64}$')
  )`,
  `CREATE TABLE IF NOT EXISTS lineage_impact.fix_proposals (
    actor_subject TEXT NOT NULL,
    session_id UUID NOT NULL,
    repository TEXT NOT NULL,
    branch TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    commit_url TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (actor_subject, session_id),
    CONSTRAINT fix_proposal_session_fk FOREIGN KEY (actor_subject, session_id)
      REFERENCES lineage_impact.omnigent_sessions (actor_subject, id),
    CONSTRAINT fix_proposal_sha_format CHECK (commit_sha ~ '^[0-9a-f]{40,64}$'),
    CONSTRAINT fix_proposal_branch_length CHECK (char_length(branch) BETWEEN 1 AND 255)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS fix_proposals_repository_branch_idx
    ON lineage_impact.fix_proposals (repository, branch)`,
  `CREATE TABLE IF NOT EXISTS lineage_impact.patch_approvals (
    id UUID PRIMARY KEY,
    actor_subject TEXT NOT NULL,
    session_id UUID NOT NULL,
    patch_id UUID NOT NULL,
    expected_head_sha TEXT NOT NULL,
    patch_digest TEXT NOT NULL,
    approved_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT patch_approval_actor_id_unique UNIQUE (actor_subject, id),
    CONSTRAINT patch_approval_identity_unique UNIQUE (
      actor_subject, session_id, expected_head_sha, patch_digest
    ),
    CONSTRAINT patch_approval_patch_fk FOREIGN KEY (actor_subject, patch_id)
      REFERENCES lineage_impact.validated_patches (actor_subject, id),
    CONSTRAINT patch_approval_expected_head_sha CHECK (expected_head_sha ~ '^[0-9a-f]{40,64}$'),
    CONSTRAINT patch_approval_digest CHECK (patch_digest ~ '^sha256:[0-9a-f]{64}$')
  )`,
  `CREATE TABLE IF NOT EXISTS lineage_impact.commit_intents (
    id UUID PRIMARY KEY,
    actor_subject TEXT NOT NULL,
    approval_id UUID NOT NULL,
    idempotency_key TEXT NOT NULL,
    assessment_reference TEXT NOT NULL,
    repository TEXT NOT NULL,
    pull_request_number INTEGER NOT NULL,
    expected_head_sha TEXT NOT NULL,
    patch_digest TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT commit_intent_actor_id_unique UNIQUE (actor_subject, id),
    CONSTRAINT commit_intent_idempotency_unique UNIQUE (actor_subject, idempotency_key),
    CONSTRAINT commit_intent_approval_fk FOREIGN KEY (actor_subject, approval_id)
      REFERENCES lineage_impact.patch_approvals (actor_subject, id),
    CONSTRAINT commit_intent_pr_number CHECK (pull_request_number > 0),
    CONSTRAINT commit_intent_expected_head_sha CHECK (expected_head_sha ~ '^[0-9a-f]{40,64}$'),
    CONSTRAINT commit_intent_patch_digest CHECK (patch_digest ~ '^sha256:[0-9a-f]{64}$')
  )`,
  `CREATE INDEX IF NOT EXISTS commit_intents_actor_assessment_idx
    ON lineage_impact.commit_intents (actor_subject, assessment_reference, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS lineage_impact.commit_audit_events (
    id UUID PRIMARY KEY,
    intent_id UUID NOT NULL,
    actor_subject TEXT NOT NULL,
    outcome TEXT NOT NULL,
    commit_sha TEXT,
    error_code TEXT,
    occurred_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT commit_audit_intent_fk FOREIGN KEY (actor_subject, intent_id)
      REFERENCES lineage_impact.commit_intents (actor_subject, id),
    CONSTRAINT commit_audit_outcome CHECK (outcome IN ('succeeded', 'failed')),
    CONSTRAINT commit_audit_commit_shape CHECK (
      (outcome = 'succeeded' AND commit_sha IS NOT NULL AND error_code IS NULL)
      OR (outcome = 'failed' AND commit_sha IS NULL AND error_code IS NOT NULL)
    ),
    CONSTRAINT commit_audit_sha_format CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40,64}$')
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS commit_audit_one_success_idx
    ON lineage_impact.commit_audit_events (intent_id) WHERE outcome = 'succeeded'`,
  `CREATE INDEX IF NOT EXISTS commit_audit_events_actor_time_idx
    ON lineage_impact.commit_audit_events (actor_subject, occurred_at DESC)`,
]);

export async function bootstrapLineageImpactStore(executor: QueryExecutor): Promise<void> {
  for (const statement of LINEAGE_IMPACT_BOOTSTRAP_SQL) {
    await executor.query(statement);
  }
}
