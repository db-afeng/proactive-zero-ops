import { sql } from '@databricks/appkit';
import { z } from 'zod';

import { splitAssetReference, type ProjectedAsset } from '../domain/evidence-projection';

const AccessRowSchema = z
  .object({
    ordinal: z.coerce.number().int().nonnegative(),
    asset_reference: z.string(),
    can_select: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((value) => value === true || value === 'true'),
    asset_type: z.string(),
  })
  .passthrough();

const QueryResultSchema = z
  .object({
    data: z.array(AccessRowSchema),
  })
  .passthrough();

export interface UserAnalyticsExecutor {
  query(queryText: string, parameters: { assets_json: ReturnType<typeof sql.string> }): Promise<unknown>;
}

export interface AssetAccessDecision {
  authorized: boolean;
  assetType: ProjectedAsset['assetType'];
}

export class AssetAuthorizationError extends Error {
  override readonly name = 'AssetAuthorizationError';
  readonly reason: 'query_failed' | 'invalid_result' | 'invalid_matrix';

  constructor(reason: AssetAuthorizationError['reason']) {
    super('Unity Catalog authorization could not be verified');
    this.reason = reason;
  }
}

/** Execute one parameterized, user-scoped access matrix and validate completeness. */
export async function authorizeAssets(options: {
  executor: UserAnalyticsExecutor;
  queryText: string;
  assets: readonly ProjectedAsset[];
}): Promise<Map<string, AssetAccessDecision>> {
  if (options.assets.length === 0) return new Map();
  const requestRows = options.assets.map((asset, ordinal) => {
    const parts = splitAssetReference(asset.reference);
    return {
      ordinal,
      asset_reference: asset.reference,
      catalog_name: parts.catalogName,
      schema_name: parts.schemaName,
      asset_name: parts.assetName,
    };
  });

  let raw: unknown;
  try {
    raw = await options.executor.query(options.queryText, {
      assets_json: sql.string(JSON.stringify(requestRows)),
    });
  } catch (error) {
    console.warn('[lineage-impact-studio] Asset access query failed', safeErrorMetadata(error));
    throw new AssetAuthorizationError('query_failed');
  }

  const parsed = QueryResultSchema.safeParse(raw);
  if (!parsed.success) throw new AssetAuthorizationError('invalid_result');
  if (parsed.data.data.length !== requestRows.length) throw new AssetAuthorizationError('invalid_matrix');

  const decisions = new Map<string, AssetAccessDecision>();
  for (const row of parsed.data.data) {
    const expected = requestRows[row.ordinal];
    if (expected === undefined || expected.asset_reference !== row.asset_reference) {
      throw new AssetAuthorizationError('invalid_matrix');
    }
    if (decisions.has(row.asset_reference)) throw new AssetAuthorizationError('invalid_matrix');
    decisions.set(row.asset_reference, {
      authorized: row.can_select,
      assetType: normalizeTableType(row.asset_type),
    });
  }
  if (decisions.size !== requestRows.length) throw new AssetAuthorizationError('invalid_matrix');
  return decisions;
}

function normalizeTableType(value: string): ProjectedAsset['assetType'] {
  switch (value.toUpperCase()) {
    case 'MANAGED':
    case 'EXTERNAL':
    case 'TABLE':
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

function safeErrorMetadata(error: unknown): Record<string, string | number> {
  if (typeof error !== 'object' || error === null) return { type: typeof error };
  const metadata: Record<string, string | number> = {
    type: error instanceof Error ? error.name : 'UnknownError',
  };
  addSafeFields(metadata, error, '');
  const cause: unknown = Reflect.get(error, 'cause');
  if (typeof cause === 'object' && cause !== null) {
    metadata.causeType = cause instanceof Error ? cause.name : 'UnknownError';
    addSafeFields(metadata, cause, 'cause');
  }
  return metadata;
}

function addSafeFields(target: Record<string, string | number>, source: object, prefix: string): void {
  for (const field of ['code', 'errorCode', 'statusCode', 'status']) {
    const value: unknown = Reflect.get(source, field);
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    target[prefix.length === 0 ? field : `${prefix}${field[0]?.toUpperCase()}${field.slice(1)}`] = value;
  }
}
