import { z } from 'zod';

import type {
  DisplayEvidence,
  RestrictedAssessmentEnvelope,
  RestrictedAssessmentEnvelopeV3,
} from './restricted-envelope';

const MAX_UNIQUE_ASSETS = 500;
const MAX_STATIC_PATH_DEPTH = 5;

const AssetReferenceSchema = z
  .string()
  .min(5)
  .max(1024)
  .refine((value) => {
    const parts = value.split('.');
    return (
      parts.length === 3 &&
      parts.every((part) => part.length > 0 && part.length <= 255 && /^[A-Za-z0-9_][A-Za-z0-9_-]*$/u.test(part))
    );
  }, 'Invalid Unity Catalog asset reference');
const ProposedCodeDependencySchema = z.object({
  source_table: AssetReferenceSchema,
  target_table: AssetReferenceSchema,
  origin: z.literal('proposed_code'),
  level: z.enum(['table', 'column']),
});
const StaticDiscoverySchema = z.object({
  proposed_code_dependencies: z.array(ProposedCodeDependencySchema).max(500),
});

export interface ProjectedAsset {
  reference: string;
  assetType: 'table' | 'view' | 'materialized_view' | 'streaming_table' | 'unknown';
}

export type EvidenceProjection =
  | {
      detailState: 'legacy';
      status: 'pass' | 'warn' | 'block' | 'error';
      uniqueAssets: [];
    }
  | {
      detailState: 'available';
      status: 'pass' | 'warn' | 'block' | 'error';
      severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
      interpretationConfidence: number;
      discoveryCertainty: 'complete' | 'incomplete';
      assessmentComplete: boolean;
      display: DisplayEvidence;
      uniqueAssets: ProjectedAsset[];
    };

export class EvidenceProjectionError extends Error {
  override readonly name = 'EvidenceProjectionError';

  constructor() {
    super('Assessment evidence cannot be projected safely');
  }
}

/**
 * Project only deterministic display evidence. Legacy v2 records deliberately
 * return no reconstructed lineage or free-form explanation.
 */
export function projectRestrictedEvidence(envelope: RestrictedAssessmentEnvelope): EvidenceProjection {
  try {
    if (envelope.schema_version === 2) {
      return {
        detailState: 'legacy',
        status: legacyStatus(envelope.evidence),
        uniqueAssets: [],
      };
    }
    validateGrounding(envelope.evidence.display_evidence);
    const display = addPotentialTransitiveImpacts(envelope);
    validateGrounding(display);
    const references = new Set<string>();
    for (const change of display.changes) references.add(change.asset);
    for (const impact of display.impacts) {
      references.add(impact.target_asset);
      for (const reference of impact.path) references.add(reference);
    }
    for (const edge of display.edges) {
      references.add(edge.source_asset);
      references.add(edge.target_asset);
    }
    if (references.size > MAX_UNIQUE_ASSETS) throw new EvidenceProjectionError();
    return {
      detailState: 'available',
      status: envelope.evidence.result.status,
      severity: envelope.evidence.result.severity,
      interpretationConfidence: envelope.evidence.result.confidence,
      discoveryCertainty: envelope.evidence.result.discovery_certainty,
      assessmentComplete: envelope.evidence.result.assessment_complete,
      display,
      uniqueAssets: [...references].sort().map((reference) => ({ reference, assetType: 'unknown' })),
    };
  } catch (error) {
    if (error instanceof EvidenceProjectionError) throw error;
    throw new EvidenceProjectionError();
  }
}

export function splitAssetReference(reference: string): {
  catalogName: string;
  schemaName: string;
  assetName: string;
} {
  const parsed = AssetReferenceSchema.parse(reference);
  const [catalogName, schemaName, assetName] = parsed.split('.');
  if (catalogName === undefined || schemaName === undefined || assetName === undefined) {
    throw new EvidenceProjectionError();
  }
  return { catalogName, schemaName, assetName };
}

function validateGrounding(display: DisplayEvidence): void {
  const changes = new Map(display.changes.map((change) => [change.id, change]));
  const requiredPairs = new Set<string>();
  for (const impact of display.impacts) {
    const change = changes.get(impact.change_id);
    if (
      change === undefined ||
      impact.path[0] !== change.asset ||
      impact.path[impact.path.length - 1] !== impact.target_asset
    ) {
      throw new EvidenceProjectionError();
    }
    if (impact.relation === 'transitive' && impact.path.length < 2) throw new EvidenceProjectionError();
    for (let index = 0; index < impact.path.length - 1; index += 1) {
      requiredPairs.add(edgeKey(impact.path[index], impact.path[index + 1]));
    }
  }

  const observedPairs = new Set<string>();
  for (const edge of display.edges) {
    const key = edgeKey(edge.source_asset, edge.target_asset);
    if (!requiredPairs.has(key)) throw new EvidenceProjectionError();
    observedPairs.add(key);
  }
  for (const pair of requiredPairs) {
    if (!observedPairs.has(pair)) throw new EvidenceProjectionError();
  }
}

/** Show parsed code paths when the remote assessment failed, without claiming observed lineage. */
function addPotentialTransitiveImpacts(envelope: RestrictedAssessmentEnvelopeV3): DisplayEvidence {
  const display = envelope.evidence.display_evidence;
  if (envelope.evidence.result.assessment_complete) return display;
  const discovery = StaticDiscoverySchema.safeParse(envelope.evidence.discovery);
  if (!discovery.success) return display;

  const adjacency = new Map<string, Set<string>>();
  for (const dependency of discovery.data.proposed_code_dependencies) {
    const source = dependency.source_table.toLowerCase();
    const target = dependency.target_table.toLowerCase();
    const next = adjacency.get(source) ?? new Set<string>();
    next.add(target);
    adjacency.set(source, next);
  }

  const impacts = [...display.impacts];
  const edges = [...display.edges];
  const impactIds = new Set(impacts.map((impact) => impact.id));
  const edgeIds = new Set(edges.map((edge) => edge.id));
  const edgePairs = new Set(edges.map((edge) => edgeKey(edge.source_asset, edge.target_asset)));
  for (const change of display.changes) {
    const existingTargets = new Set(
      impacts.filter((impact) => impact.change_id === change.id).map((impact) => impact.target_asset)
    );
    const directBreaks = impacts.filter(
      (impact) =>
        impact.change_id === change.id &&
        impact.relation === 'direct' &&
        impact.path.length === 2 &&
        impact.path[0] === change.asset &&
        impact.reason !== 'semantic_change' &&
        impact.reason !== 'manual_review'
    );
    const queue = directBreaks.map((impact) => impact.path);
    const visited = new Set(queue.map((path) => path.join('\u0000')));
    while (queue.length > 0 && impacts.length < 500 && edges.length < 500) {
      const path = queue.shift();
      if (path === undefined || path.length - 1 >= MAX_STATIC_PATH_DEPTH) continue;
      for (const target of [...(adjacency.get(path[path.length - 1]) ?? [])].sort()) {
        if (path.includes(target)) continue;
        const nextPath = [...path, target];
        const key = nextPath.join('\u0000');
        if (visited.has(key)) continue;
        visited.add(key);
        if (queue.length < 500) queue.push(nextPath);
        if (existingTargets.has(target)) continue;
        const missingPairs = nextPath
          .slice(1)
          .filter((destination, index) => !edgePairs.has(edgeKey(nextPath[index], destination))).length;
        if (edges.length + missingPairs > 500) return { ...display, impacts, edges };
        existingTargets.add(target);
        const id = nextIdentifier('impact', impactIds);
        impacts.push({
          id,
          change_id: change.id,
          relation: 'transitive',
          target_asset: target,
          target_column: null,
          operation: 'unknown',
          reason: 'upstream_failure',
          evidence_level: 'definition',
          path: nextPath,
          target_expression: null,
          remediation: 'restore_contract',
        });
        for (let index = 0; index < nextPath.length - 1; index += 1) {
          const source = nextPath[index];
          const destination = nextPath[index + 1];
          const pair = edgeKey(source, destination);
          if (edgePairs.has(pair)) continue;
          edgePairs.add(pair);
          edges.push({
            id: nextIdentifier('edge', edgeIds),
            source_asset: source,
            target_asset: destination,
            source_column: null,
            target_column: null,
            level: 'table',
            origins: ['proposed_code'],
            last_observed_at: null,
          });
        }
      }
    }
  }
  return { ...display, impacts, edges };
}

function nextIdentifier(prefix: string, used: Set<string>): string {
  let index = used.size + 1;
  while (used.has(`${prefix}-${index}`)) index += 1;
  const id = `${prefix}-${index}`;
  used.add(id);
  return id;
}

function legacyStatus(evidence: unknown): 'pass' | 'warn' | 'block' | 'error' {
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) return 'error';
  const result = z.unknown().parse(Reflect.get(evidence, 'result'));
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return 'error';
  const parsed = z.enum(['pass', 'warn', 'block', 'error']).safeParse(Reflect.get(result, 'status'));
  return parsed.success ? parsed.data : 'error';
}

function edgeKey(source: string, target: string): string {
  return `${source}\u0000${target}`;
}
