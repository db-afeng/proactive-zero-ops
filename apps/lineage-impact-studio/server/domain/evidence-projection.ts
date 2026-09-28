import { z } from 'zod';

import type { RestrictedAssessmentEnvelopeV2 } from './restricted-envelope';

const MAX_LINEAGE_PATHS = 100;
const MAX_UNIQUE_ASSETS = 500;

const AssetReferenceSchema = z
  .string()
  .min(5)
  .max(1024)
  .transform((value) => value.trim())
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

export interface EvidenceProjection {
  status: 'pass' | 'warn' | 'block' | 'error';
  lineagePaths: ProjectedAsset[][];
  uniqueAssets: ProjectedAsset[];
}

export class EvidenceProjectionError extends Error {
  override readonly name = 'EvidenceProjectionError';

  constructor() {
    super('Assessment evidence cannot be projected safely');
  }
}

/**
 * Extract only validated UC references and the public status. No free-form
 * evidence string is eligible for a browser DTO through this projection.
 */
export function projectRestrictedEvidence(envelope: RestrictedAssessmentEnvelopeV2): EvidenceProjection {
  try {
    const evidence = asRecord(envelope.evidence);
    const result = asRecord(evidence.result);
    const status = z.enum(['pass', 'warn', 'block', 'error']).parse(result.status);
    const paths: ProjectedAsset[][] = [];
    const typeByReference = new Map<string, ProjectedAsset['assetType']>();

    collectImpactPaths(result.impacts, paths);
    collectImpactPaths(asRecordOrUndefined(evidence.model_assessment)?.impacts, paths);

    const discovery = asRecordOrUndefined(evidence.discovery);
    collectSingleAssetPaths(discovery?.affected_datasets, paths);
    collectEdges(result.lineage_edges, paths, typeByReference);
    collectEdges(discovery?.proposed_code_dependencies, paths, typeByReference);

    for (const value of asArray(result.changed_columns)) {
      const candidate = parseAssetReference(asRecordOrUndefined(value)?.table);
      if (candidate !== null) paths.push([{ reference: candidate, assetType: 'unknown' }]);
    }

    const normalizedPaths = deduplicatePaths(paths).map((path) =>
      path.map((asset) => ({
        ...asset,
        assetType: typeByReference.get(asset.reference) ?? asset.assetType,
      }))
    );
    const uniqueAssets = deduplicateAssets(normalizedPaths.flat());

    if (normalizedPaths.length > MAX_LINEAGE_PATHS || uniqueAssets.length > MAX_UNIQUE_ASSETS) {
      throw new EvidenceProjectionError();
    }

    return { status, lineagePaths: normalizedPaths, uniqueAssets };
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

function collectImpactPaths(value: unknown, paths: ProjectedAsset[][]): void {
  for (const item of asArray(value)) {
    const record = asRecordOrUndefined(item);
    const path = record === undefined ? [] : parsePath(record.path);
    if (path.length > 0) paths.push(path);
  }
}

function collectSingleAssetPaths(value: unknown, paths: ProjectedAsset[][]): void {
  for (const item of asArray(value)) {
    const reference = parseAssetReference(item);
    if (reference !== null) paths.push([{ reference, assetType: 'unknown' }]);
  }
}

function collectEdges(
  value: unknown,
  paths: ProjectedAsset[][],
  typeByReference: Map<string, ProjectedAsset['assetType']>
): void {
  for (const item of asArray(value)) {
    const edge = asRecordOrUndefined(item);
    if (edge === undefined) continue;
    const source = parseAssetReference(edge.source_table);
    const target = parseAssetReference(edge.target_table);
    if (source === null || target === null) continue;
    const targetType = normalizeAssetType(edge.target_type);
    typeByReference.set(target, targetType);
    paths.push([
      { reference: source, assetType: typeByReference.get(source) ?? 'unknown' },
      { reference: target, assetType: targetType },
    ]);
  }
}

function parsePath(value: unknown): ProjectedAsset[] {
  const result: ProjectedAsset[] = [];
  for (const item of asArray(value)) {
    const reference = parseAssetReference(item);
    if (reference !== null) result.push({ reference, assetType: 'unknown' });
  }
  return result;
}

function parseAssetReference(value: unknown): string | null {
  const parsed = AssetReferenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function normalizeAssetType(value: unknown): ProjectedAsset['assetType'] {
  if (typeof value !== 'string') return 'unknown';
  switch (value.toUpperCase()) {
    case 'TABLE':
    case 'MANAGED':
    case 'EXTERNAL':
      return 'table';
    case 'VIEW':
      return 'view';
    case 'MATERIALIZED_VIEW':
      return 'materialized_view';
    case 'STREAMING_TABLE':
      return 'streaming_table';
    default:
      return 'unknown';
  }
}

function deduplicatePaths(paths: readonly ProjectedAsset[][]): ProjectedAsset[][] {
  const seen = new Set<string>();
  const result: ProjectedAsset[][] = [];
  for (const path of paths) {
    if (path.length === 0) continue;
    const key = path.map((asset) => asset.reference).join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }
  return result;
}

function deduplicateAssets(assets: readonly ProjectedAsset[]): ProjectedAsset[] {
  const result = new Map<string, ProjectedAsset>();
  for (const asset of assets) {
    const previous = result.get(asset.reference);
    if (previous === undefined || previous.assetType === 'unknown') result.set(asset.reference, asset);
  }
  return [...result.values()];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  const record = asRecordOrUndefined(value);
  if (record === undefined) throw new EvidenceProjectionError();
  return record;
}

function asRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
