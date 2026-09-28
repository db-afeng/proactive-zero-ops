export type AssessmentStatus = 'pass' | 'warn' | 'block' | 'error';
export type AssessmentFreshness = 'current' | 'stale' | 'unknown';

export interface AuthorizedLineageSegment {
  kind: 'asset';
  reference: string;
  assetType: 'table' | 'view' | 'materialized_view' | 'streaming_table' | 'unknown';
}

export interface RestrictedLineageSegment {
  kind: 'restricted';
}

export type LineageSegment = AuthorizedLineageSegment | RestrictedLineageSegment;

export interface AssessmentViewV1 {
  schemaVersion: 1;
  reference: string;
  status: AssessmentStatus;
  message: string;
  source: {
    provider: 'github';
    createdAt: string;
    freshness: AssessmentFreshness;
  };
  pullRequest: {
    repository: string;
    number: number;
    baseSha: string;
    headSha: string;
  };
  viewer: {
    subject: string;
    displayName: string;
  };
  lineagePaths: Array<{
    segments: LineageSegment[];
  }>;
  disclosure: {
    state: 'full' | 'partial' | 'none';
    notice: string;
  };
}

export interface GitHubConnection {
  connected: boolean;
  login?: string;
}

export interface Capabilities {
  omnigent: {
    available: boolean;
    reason?: string;
  };
}

export type FixSessionStatus = 'queued' | 'running' | 'validating' | 'complete' | 'failed' | 'cancelled';

export interface FixSession {
  id: string;
  status: FixSessionStatus;
  progress?: number;
  message?: string;
  error?: string;
  approvedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PatchFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  original: string;
  modified: string;
  language: string;
}

export interface PatchValidation {
  name: string;
  status: 'passed' | 'failed' | 'pending';
  message: string;
}

export interface ValidatedPatch {
  sessionId: string;
  status: string;
  patchDigest: string;
  baseSha: string;
  files: PatchFile[];
  validations: PatchValidation[];
}

export interface FixStreamEvent {
  type: 'snapshot' | 'progress' | 'complete' | 'failed';
  session: FixSession;
}

export interface CommitOutcome {
  outcome: string;
  commitSha?: string;
  message?: string;
}

export interface AuditRecord {
  id: string;
  actor: string;
  expectedHeadSha: string;
  patchDigest: string;
  approvedAt: string;
  committedAt?: string;
  outcome: string;
  commitSha?: string;
}

export interface AuditResponse {
  records: AuditRecord[];
}
