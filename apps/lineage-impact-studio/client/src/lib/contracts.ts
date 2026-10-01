export type AssessmentStatus = 'pass' | 'warn' | 'block' | 'error';
export type AssessmentFreshness = 'current' | 'stale' | 'unknown';
export type AssessmentSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';
export type TypeFamily = 'numeric' | 'text' | 'boolean' | 'date' | 'timestamp' | 'complex' | 'unknown';
export type OperationKind =
  | 'arithmetic'
  | 'aggregate'
  | 'comparison'
  | 'filter'
  | 'join'
  | 'cast'
  | 'constraint'
  | 'pass_through'
  | 'unknown';
export type ImpactReasonCode =
  | 'incompatible_type'
  | 'missing_column'
  | 'renamed_column'
  | 'incompatible_operation'
  | 'semantic_change'
  | 'upstream_failure'
  | 'manual_review';
export type RemediationKind = 'restore_contract' | 'add_compatibility_column' | 'update_consumers' | 'reassess';

export interface AuthorizedLineageSegment {
  kind: 'asset';
  reference: string;
  assetType: 'table' | 'view' | 'materialized_view' | 'streaming_table' | 'unknown';
}

export interface RestrictedLineageSegment {
  kind: 'restricted';
}

export type LineageSegment = AuthorizedLineageSegment | RestrictedLineageSegment;

export interface AssessmentChange {
  id: string;
  asset: string;
  column: string;
  changeKind: 'added' | 'deleted' | 'renamed' | 'modified';
  beforeType: TypeFamily;
  afterType: TypeFamily;
}

export interface AssessmentImpact {
  id: string;
  changeId: string;
  relation: 'direct' | 'transitive';
  targetAsset: string;
  targetColumn: string | null;
  operation: OperationKind;
  reason: ImpactReasonCode;
  evidenceLevel: 'definition' | 'lineage';
  path: LineageSegment[];
  remediation: RemediationKind;
}

export interface AssessmentGraphNode {
  id: string;
  role: 'changed' | 'direct_break' | 'transitive_impact' | 'context' | 'restricted';
  label: string;
  asset?: string;
  assetType?: AuthorizedLineageSegment['assetType'];
  column?: string;
  changeId?: string;
  impactId?: string;
}

export interface AssessmentGraphEdge {
  id: string;
  source: string;
  target: string;
  origin: 'observed_lineage' | 'proposed_code' | 'mixed' | 'unknown';
  evidenceLevel: 'column' | 'table' | 'definition';
  lastObservedAt: string | null;
  sourceAsset: string | null;
  sourceColumn: string | null;
  targetAsset: string | null;
  targetColumn: string | null;
}

export interface AssessmentViewV3 {
  schemaVersion: 3;
  reference: string;
  detailState: 'available' | 'legacy';
  status: AssessmentStatus;
  severity: AssessmentSeverity;
  message: string;
  headline: string;
  recommendedAction: string;
  source: {
    provider: 'github';
    createdAt: string;
    freshness: AssessmentFreshness;
    evidenceOrigin: 'observed_lineage' | 'proposed_code' | 'mixed' | 'unavailable';
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
  confidence: {
    interpretation: number | null;
    discovery: 'complete' | 'incomplete' | 'unknown';
  };
  changes: AssessmentChange[];
  impacts: AssessmentImpact[];
  graph: {
    nodes: AssessmentGraphNode[];
    edges: AssessmentGraphEdge[];
  };
  disclosure: {
    state: 'full' | 'partial' | 'none';
    notice: string;
  };
}

export type UsageObjectKind = 'query' | 'dashboard' | 'genie' | 'notebook' | 'pipeline' | 'job' | 'alert';

export interface AssessmentUsageObject {
  kind: UsageObjectKind;
  title: string;
  url: string;
  relation: 'direct' | 'indirect';
  viaAssets: string[];
  accessMode: 'read' | 'write' | 'read_write';
  lastObservedAt: string;
}

export interface AssessmentAssetUsage {
  asset: string;
  count: number;
  directCount: number;
  indirectCount: number;
  byType: Record<UsageObjectKind, number>;
  complete: boolean;
  objects: AssessmentUsageObject[];
}

export interface AssessmentUsageV1 {
  schemaVersion: 1;
  assessmentReference: string;
  observedFrom: string;
  observedThrough: string;
  assets: AssessmentAssetUsage[];
}

export interface SourceEvidenceView {
  schemaVersion: 1;
  assessmentReference: string;
  pullRequestFilesUrl: string;
  changes: Array<{
    id: string;
    filePath: string | null;
    diffUrl: string | null;
    beforeExpression: string | null;
    afterExpression: string | null;
  }>;
  impacts: Array<{
    id: string;
    targetExpression: string | null;
  }>;
}

export interface GitHubConnection {
  connected: boolean;
  login?: string;
}

export interface Capabilities {
  omnigent: {
    available: boolean;
    authorizationRequired?: boolean;
    authMode?: 'obo' | 'service-principal';
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
  proposal: {
    repository: string;
    branch: string;
    commitSha: string;
    commitUrl: string | null;
    createdAt: string;
  } | null;
  files: PatchFile[];
  validations: PatchValidation[];
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
