import { z } from 'zod';

import type {
  DisplayEvidence,
  RestrictedAssessmentEnvelope,
  RestrictedAssessmentEnvelopeV3,
} from './restricted-envelope';

const MAX_UNIQUE_ASSETS = 500;

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
    validateGrounding(envelope);
    const references = new Set<string>();
    for (const change of envelope.evidence.display_evidence.changes) references.add(change.asset);
    for (const impact of envelope.evidence.display_evidence.impacts) {
      references.add(impact.target_asset);
      for (const reference of impact.path) references.add(reference);
    }
    for (const edge of envelope.evidence.display_evidence.edges) {
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
      display: envelope.evidence.display_evidence,
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

function validateGrounding(envelope: RestrictedAssessmentEnvelopeV3): void {
  const display = envelope.evidence.display_evidence;
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
