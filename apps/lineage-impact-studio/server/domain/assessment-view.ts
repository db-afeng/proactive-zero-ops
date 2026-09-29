import { z } from 'zod';

import type { EvidenceProjection } from './evidence-projection';
import { AssessmentReferenceSchema, CommitShaSchema, GitHubRepositorySchema } from './identifiers';
import {
  ImpactReasonCodeSchema,
  OperationKindSchema,
  RemediationKindSchema,
  TypeFamilySchema,
} from './restricted-envelope';

export const AssessmentStatusSchema = z.enum(['pass', 'warn', 'block', 'error']);
export const AssessmentFreshnessSchema = z.enum(['current', 'stale', 'unknown']);
export const DisclosureStateSchema = z.enum(['full', 'partial', 'none']);
export const AssetTypeSchema = z.enum(['table', 'view', 'materialized_view', 'streaming_table', 'unknown']);

const SafeTextSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => value === value.trim() && !hasUnsafeTextCharacter(value));
const AssetReferenceSchema = SafeTextSchema;
const ColumnNameSchema = SafeTextSchema;

export const LineageSegmentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('asset'),
      reference: AssetReferenceSchema,
      assetType: AssetTypeSchema,
    })
    .strict(),
  z.object({ kind: z.literal('restricted') }).strict(),
]);

export type LineageSegment = z.infer<typeof LineageSegmentSchema>;

export const AssessmentChangeSchema = z
  .object({
    id: SafeTextSchema,
    asset: AssetReferenceSchema,
    column: ColumnNameSchema,
    changeKind: z.enum(['added', 'deleted', 'renamed', 'modified']),
    beforeType: TypeFamilySchema,
    afterType: TypeFamilySchema,
  })
  .strict();

export const AssessmentImpactSchema = z
  .object({
    id: SafeTextSchema,
    changeId: SafeTextSchema,
    relation: z.enum(['direct', 'transitive']),
    targetAsset: AssetReferenceSchema,
    targetColumn: ColumnNameSchema.nullable(),
    operation: OperationKindSchema,
    reason: ImpactReasonCodeSchema,
    evidenceLevel: z.enum(['definition', 'lineage']),
    path: z.array(LineageSegmentSchema).min(1),
    remediation: RemediationKindSchema,
  })
  .strict();

export const AssessmentGraphNodeSchema = z
  .object({
    id: SafeTextSchema,
    role: z.enum(['changed', 'direct_break', 'transitive_impact', 'context', 'restricted']),
    label: SafeTextSchema,
    asset: AssetReferenceSchema.optional(),
    assetType: AssetTypeSchema.optional(),
    column: ColumnNameSchema.optional(),
    changeId: SafeTextSchema.optional(),
    impactId: SafeTextSchema.optional(),
  })
  .strict();

export const AssessmentGraphEdgeSchema = z
  .object({
    id: SafeTextSchema,
    source: SafeTextSchema,
    target: SafeTextSchema,
    origin: z.enum(['observed_lineage', 'proposed_code', 'mixed', 'unknown']),
    evidenceLevel: z.enum(['column', 'table', 'definition']),
    lastObservedAt: z.iso.datetime({ offset: true }).nullable(),
    sourceAsset: AssetReferenceSchema.nullable(),
    sourceColumn: ColumnNameSchema.nullable(),
    targetAsset: AssetReferenceSchema.nullable(),
    targetColumn: ColumnNameSchema.nullable(),
  })
  .strict();

const STATUS_MESSAGES = {
  pass: 'No blocking downstream impact was identified.',
  warn: 'The assessment completed with a non-blocking warning.',
  block: 'A potentially breaking downstream impact was identified.',
  error: 'The assessment could not be completed safely.',
} as const;

const DISCLOSURE_NOTICES = {
  full: 'All referenced lineage assets are visible to you.',
  partial: 'Some lineage is hidden because you do not have access.',
  none: 'Lineage details are hidden because you do not have access.',
} as const;

export const AssessmentViewV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    reference: AssessmentReferenceSchema,
    detailState: z.enum(['available', 'legacy']),
    status: AssessmentStatusSchema,
    severity: z.enum(['none', 'low', 'medium', 'high', 'critical']),
    message: SafeTextSchema,
    headline: SafeTextSchema,
    recommendedAction: SafeTextSchema,
    source: z
      .object({
        provider: z.literal('github'),
        createdAt: z.iso.datetime({ offset: true }),
        freshness: AssessmentFreshnessSchema,
        evidenceOrigin: z.enum(['observed_lineage', 'proposed_code', 'mixed', 'unavailable']),
      })
      .strict(),
    pullRequest: z
      .object({
        repository: GitHubRepositorySchema,
        number: z.number().int().positive(),
        baseSha: CommitShaSchema,
        headSha: CommitShaSchema,
      })
      .strict(),
    viewer: z
      .object({
        subject: SafeTextSchema,
        displayName: SafeTextSchema,
      })
      .strict(),
    confidence: z
      .object({
        interpretation: z.number().min(0).max(1).nullable(),
        discovery: z.enum(['complete', 'incomplete', 'unknown']),
      })
      .strict(),
    changes: z.array(AssessmentChangeSchema),
    impacts: z.array(AssessmentImpactSchema),
    graph: z
      .object({
        nodes: z.array(AssessmentGraphNodeSchema),
        edges: z.array(AssessmentGraphEdgeSchema),
      })
      .strict(),
    disclosure: z
      .object({
        state: DisclosureStateSchema,
        notice: SafeTextSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((view, context) => {
    if (view.message !== STATUS_MESSAGES[view.status]) {
      context.addIssue({ code: 'custom', path: ['message'], message: 'Status message mismatch' });
    }
    if (view.disclosure.notice !== DISCLOSURE_NOTICES[view.disclosure.state]) {
      context.addIssue({ code: 'custom', path: ['disclosure', 'notice'], message: 'Disclosure notice mismatch' });
    }
    if (
      view.detailState === 'legacy' &&
      (view.changes.length > 0 || view.impacts.length > 0 || view.graph.nodes.length > 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['detailState'],
        message: 'Legacy views cannot contain reconstructed detail',
      });
    }
  });

export type AssessmentViewV3 = z.infer<typeof AssessmentViewV3Schema>;

export interface AssetAccessDecision {
  authorized: boolean;
  assetType: z.infer<typeof AssetTypeSchema>;
}

export interface AssessmentViewV3Input {
  reference: string;
  projection: EvidenceProjection;
  source: Omit<AssessmentViewV3['source'], 'evidenceOrigin'>;
  pullRequest: AssessmentViewV3['pullRequest'];
  viewer: AssessmentViewV3['viewer'];
  access: ReadonlyMap<string, AssetAccessDecision>;
}

/** Build the browser DTO from deterministic evidence and per-asset OBO decisions. */
export function createAssessmentViewV3(input: AssessmentViewV3Input): AssessmentViewV3 {
  if (input.projection.detailState === 'legacy') {
    return AssessmentViewV3Schema.parse({
      schemaVersion: 3,
      reference: input.reference,
      detailState: 'legacy',
      status: input.projection.status,
      severity: 'none',
      message: STATUS_MESSAGES[input.projection.status],
      headline: 'Detailed explanation is unavailable for this assessment.',
      recommendedAction: 'Re-run the assessment to generate verified change and lineage evidence.',
      source: { ...input.source, evidenceOrigin: 'unavailable' },
      pullRequest: input.pullRequest,
      viewer: input.viewer,
      confidence: { interpretation: null, discovery: 'unknown' },
      changes: [],
      impacts: [],
      graph: { nodes: [], edges: [] },
      disclosure: { state: 'full', notice: DISCLOSURE_NOTICES.full },
    });
  }

  const display = input.projection.display;
  const authorizedChanges = display.changes.filter((change) => input.access.get(change.asset)?.authorized === true);
  const changeIds = new Set(authorizedChanges.map((change) => change.id));
  const authorizedImpacts = display.impacts.filter(
    (impact) => changeIds.has(impact.change_id) && input.access.get(impact.target_asset)?.authorized === true
  );
  const hiddenReferences = input.projection.uniqueAssets.filter(
    (asset) => input.access.get(asset.reference)?.authorized !== true
  );
  const disclosureState = hiddenReferences.length === 0 ? 'full' : authorizedChanges.length > 0 ? 'partial' : 'none';
  const changes = authorizedChanges.map((change) => ({
    id: change.id,
    asset: change.asset,
    column: change.column,
    changeKind: change.change_kind,
    beforeType: change.before_type,
    afterType: change.after_type,
  }));
  const impacts = authorizedImpacts.map((impact) => ({
    id: impact.id,
    changeId: impact.change_id,
    relation: impact.relation,
    targetAsset: impact.target_asset,
    targetColumn: impact.target_column,
    operation: impact.operation,
    reason: impact.reason,
    evidenceLevel: impact.evidence_level,
    path: redactPath(impact.path, input.access),
    remediation: impact.remediation,
  }));
  const graph = buildGraph({
    changes,
    impacts,
    evidenceEdges: display.edges,
    access: input.access,
    includeRestricted: hiddenReferences.length > 0,
  });
  const origins = new Set(graph.edges.map((edge) => edge.origin).filter((origin) => origin !== 'unknown'));
  const evidenceOrigin =
    origins.size === 0
      ? 'unavailable'
      : origins.size > 1
        ? 'mixed'
        : origins.has('observed_lineage')
          ? 'observed_lineage'
          : 'proposed_code';
  const messages = authorizedMessages({
    fullyAuthorized: hiddenReferences.length === 0,
    displayHeadline: display.headline,
    displayAction: display.recommended_action,
    changes,
    impacts,
  });

  return AssessmentViewV3Schema.parse({
    schemaVersion: 3,
    reference: input.reference,
    detailState: 'available',
    status: input.projection.status,
    severity: input.projection.severity,
    message: STATUS_MESSAGES[input.projection.status],
    headline: messages.headline,
    recommendedAction: messages.recommendedAction,
    source: { ...input.source, evidenceOrigin },
    pullRequest: input.pullRequest,
    viewer: input.viewer,
    confidence: {
      interpretation: input.projection.interpretationConfidence,
      discovery: input.projection.discoveryCertainty,
    },
    changes,
    impacts,
    graph,
    disclosure: { state: disclosureState, notice: DISCLOSURE_NOTICES[disclosureState] },
  });
}

function authorizedMessages(input: {
  fullyAuthorized: boolean;
  displayHeadline: string;
  displayAction: string;
  changes: AssessmentViewV3['changes'];
  impacts: AssessmentViewV3['impacts'];
}): { headline: string; recommendedAction: string } {
  if (input.fullyAuthorized) {
    return { headline: input.displayHeadline, recommendedAction: input.displayAction };
  }
  const change = input.changes[0];
  const impact = input.impacts[0];
  if (change === undefined) {
    return {
      headline: 'A restricted upstream contract change may affect an asset you can access.',
      recommendedAction:
        'Ask an authorized owner to review the hidden change and re-run the assessment before merging.',
    };
  }
  if (impact === undefined) {
    return {
      headline: `${change.column} changes its output contract; some downstream details are restricted.`,
      recommendedAction: 'Preserve the existing contract or ask an authorized owner to review every hidden consumer.',
    };
  }
  return {
    headline: `${change.column} changes from ${change.beforeType} to ${change.afterType}, but ${shortAsset(impact.targetAsset)} still uses the previous contract.`,
    recommendedAction: 'Restore the existing contract or update every verified consumer before merging.',
  };
}

export function serializeAssessmentViewV3(value: unknown): string {
  return JSON.stringify(AssessmentViewV3Schema.parse(value));
}

const SourceExpressionSchema = z.string().min(1).max(100_000).nullable();

export const SourceEvidenceViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    assessmentReference: AssessmentReferenceSchema,
    pullRequestFilesUrl: z.string().url(),
    changes: z.array(
      z
        .object({
          id: SafeTextSchema,
          filePath: z.string().min(1).max(4096).nullable(),
          diffUrl: z.string().url().nullable(),
          beforeExpression: SourceExpressionSchema,
          afterExpression: SourceExpressionSchema,
        })
        .strict()
    ),
    impacts: z.array(
      z
        .object({
          id: SafeTextSchema,
          targetExpression: SourceExpressionSchema,
        })
        .strict()
    ),
  })
  .strict();

export type SourceEvidenceView = z.infer<typeof SourceEvidenceViewSchema>;

export function serializeSourceEvidenceView(value: unknown): string {
  return JSON.stringify(SourceEvidenceViewSchema.parse(value));
}

function buildGraph(input: {
  changes: AssessmentViewV3['changes'];
  impacts: AssessmentViewV3['impacts'];
  evidenceEdges: readonly EvidenceEdgeInput[];
  access: ReadonlyMap<string, AssetAccessDecision>;
  includeRestricted: boolean;
}): AssessmentViewV3['graph'] {
  const nodes: AssessmentViewV3['graph']['nodes'] = [];
  const edges: AssessmentViewV3['graph']['edges'] = [];
  const nodeByAsset = new Map<string, string[]>();
  for (const change of input.changes) {
    const id = `change-${change.id}`;
    nodes.push({
      id,
      role: 'changed',
      label: `${shortAsset(change.asset)}.${change.column}`,
      asset: change.asset,
      assetType: input.access.get(change.asset)?.assetType ?? 'unknown',
      column: change.column,
      changeId: change.id,
    });
    addNodeByAsset(nodeByAsset, change.asset, id);
  }
  for (const impact of input.impacts) {
    const id = `impact-${impact.id}`;
    const label =
      impact.targetColumn === null
        ? shortAsset(impact.targetAsset)
        : `${shortAsset(impact.targetAsset)}.${impact.targetColumn}`;
    nodes.push({
      id,
      role:
        impact.relation === 'transitive'
          ? 'transitive_impact'
          : impact.reason === 'semantic_change' || impact.reason === 'manual_review'
            ? 'context'
            : 'direct_break',
      label,
      asset: impact.targetAsset,
      assetType: input.access.get(impact.targetAsset)?.assetType ?? 'unknown',
      ...(impact.targetColumn === null ? {} : { column: impact.targetColumn }),
      impactId: impact.id,
    });
    addNodeByAsset(nodeByAsset, impact.targetAsset, id);
  }
  const representedAssets = new Set(nodeByAsset.keys());
  const contextAssets = new Map<string, { assetType: AssetAccessDecision['assetType'] }>();
  for (const impact of input.impacts) {
    for (const segment of impact.path.slice(1, -1)) {
      if (segment.kind === 'asset' && !representedAssets.has(segment.reference)) {
        contextAssets.set(segment.reference, { assetType: segment.assetType });
      }
    }
  }
  let contextIndex = 0;
  for (const [asset, context] of contextAssets) {
    contextIndex += 1;
    const id = `context-${String(contextIndex)}`;
    nodes.push({
      id,
      role: 'context',
      label: shortAsset(asset),
      asset,
      assetType: context.assetType,
    });
    addNodeByAsset(nodeByAsset, asset, id);
  }
  if (input.includeRestricted) nodes.push({ id: 'restricted', role: 'restricted', label: 'Restricted lineage' });

  const edgeKeys = new Set<string>();
  for (const impact of input.impacts) {
    const target = `impact-${impact.id}`;
    const change = input.changes.find((candidate) => candidate.id === impact.changeId);
    const changedSource = change === undefined ? undefined : `change-${impact.changeId}`;
    if (impact.relation === 'direct' || impact.path.length < 2) {
      const source = changedSource ?? (input.includeRestricted ? 'restricted' : undefined);
      if (source === undefined || source === target) continue;
      const sourceAsset = impact.path[0]?.kind === 'asset' ? impact.path[0].reference : null;
      const evidence = findEvidenceEdge(input.evidenceEdges, sourceAsset, impact.targetAsset);
      const authorizedEdge = sourceAsset !== null;
      pushGraphEdge(edges, edgeKeys, {
        id: `graph-${source}-${target}`,
        source,
        target,
        origin: evidenceOrigin(evidence),
        evidenceLevel: evidence?.level ?? 'definition',
        lastObservedAt: evidence?.last_observed_at ?? null,
        sourceAsset: authorizedEdge ? sourceAsset : null,
        sourceColumn: authorizedEdge ? (evidence?.source_column ?? change?.column ?? null) : null,
        targetAsset: authorizedEdge ? impact.targetAsset : null,
        targetColumn: authorizedEdge ? (evidence?.target_column ?? impact.targetColumn) : null,
      });
      continue;
    }

    for (let index = 0; index < impact.path.length - 1; index += 1) {
      const sourceSegment = impact.path[index];
      const targetSegment = impact.path[index + 1];
      const source =
        index === 0 && changedSource !== undefined
          ? changedSource
          : graphNodeForSegment(sourceSegment, nodeByAsset, undefined);
      const destination =
        index === impact.path.length - 2 ? target : graphNodeForSegment(targetSegment, nodeByAsset, target);
      if (source === undefined || destination === undefined || source === destination) continue;
      const sourceAsset = sourceSegment?.kind === 'asset' ? sourceSegment.reference : null;
      const targetAsset = targetSegment?.kind === 'asset' ? targetSegment.reference : null;
      const evidence =
        targetAsset === null ? undefined : findEvidenceEdge(input.evidenceEdges, sourceAsset, targetAsset);
      const authorizedEdge = sourceAsset !== null && targetAsset !== null;
      pushGraphEdge(edges, edgeKeys, {
        id: `graph-${source}-${destination}`,
        source,
        target: destination,
        origin:
          sourceSegment?.kind === 'restricted' || targetSegment?.kind === 'restricted'
            ? 'unknown'
            : evidenceOrigin(evidence),
        evidenceLevel: evidence?.level ?? 'table',
        lastObservedAt: evidence?.last_observed_at ?? null,
        sourceAsset: authorizedEdge ? sourceAsset : null,
        sourceColumn: authorizedEdge
          ? (evidence?.source_column ?? (index === 0 ? (change?.column ?? null) : null))
          : null,
        targetAsset: authorizedEdge ? targetAsset : null,
        targetColumn: authorizedEdge
          ? (evidence?.target_column ?? (index === impact.path.length - 2 ? impact.targetColumn : null))
          : null,
      });
    }
  }
  if (
    input.includeRestricted &&
    nodes.length > 1 &&
    !edges.some((edge) => edge.source === 'restricted' || edge.target === 'restricted')
  ) {
    const firstVisible = nodes.find((node) => node.role !== 'restricted');
    if (firstVisible !== undefined) {
      pushGraphEdge(edges, edgeKeys, {
        id: `graph-restricted-${firstVisible.id}`,
        source: 'restricted',
        target: firstVisible.id,
        origin: 'unknown',
        evidenceLevel: 'table',
        lastObservedAt: null,
        sourceAsset: null,
        sourceColumn: null,
        targetAsset: null,
        targetColumn: null,
      });
    }
  }
  return { nodes, edges };
}

interface EvidenceEdgeInput {
  source_asset: string;
  target_asset: string;
  source_column: string | null;
  target_column: string | null;
  level: 'column' | 'table';
  origins: readonly ('observed_lineage' | 'proposed_code')[];
  last_observed_at: string | null;
}

function findEvidenceEdge(
  edges: readonly EvidenceEdgeInput[],
  source: string | null,
  target: string
): EvidenceEdgeInput | undefined {
  if (source === null) return undefined;
  return edges.find((edge) => edge.source_asset === source && edge.target_asset === target);
}

function evidenceOrigin(edge: EvidenceEdgeInput | undefined): 'observed_lineage' | 'proposed_code' | 'mixed' {
  if (edge === undefined || edge.origins.length === 0) return 'proposed_code';
  if (edge.origins.length > 1) return 'mixed';
  return edge.origins[0] ?? 'proposed_code';
}

function pushGraphEdge(
  result: AssessmentViewV3['graph']['edges'],
  keys: Set<string>,
  edge: AssessmentViewV3['graph']['edges'][number]
): void {
  const key = `${edge.source}\u0000${edge.target}`;
  if (keys.has(key)) return;
  keys.add(key);
  result.push(edge);
}

function graphNodeForSegment(
  segment: LineageSegment | undefined,
  nodeByAsset: ReadonlyMap<string, string[]>,
  excluded: string | undefined
): string | undefined {
  if (segment?.kind === 'restricted') return 'restricted';
  if (segment?.kind !== 'asset') return undefined;
  return nodeByAsset.get(segment.reference)?.find((id) => id !== excluded);
}

function redactPath(path: readonly string[], access: ReadonlyMap<string, AssetAccessDecision>): LineageSegment[] {
  const result: LineageSegment[] = [];
  let restricted = false;
  for (const reference of path) {
    const decision = access.get(reference);
    if (decision?.authorized === true) {
      result.push({ kind: 'asset', reference, assetType: decision.assetType });
      restricted = false;
    } else if (!restricted) {
      result.push({ kind: 'restricted' });
      restricted = true;
    }
  }
  return result;
}

function addNodeByAsset(map: Map<string, string[]>, asset: string, id: string): void {
  const existing = map.get(asset) ?? [];
  existing.push(id);
  map.set(asset, existing);
}

function shortAsset(reference: string): string {
  const parts = reference.split('.');
  return parts[parts.length - 1] ?? reference;
}

function hasUnsafeTextCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f || codePoint === 0x2028 || codePoint === 0x2029) return true;
  }
  return false;
}
