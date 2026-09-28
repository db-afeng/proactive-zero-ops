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

  constructor() {
    super('Unity Catalog authorization could not be verified');
  }
}

/** Execute one parameterized, user-scoped access matrix and validate completeness. */
export async function authorizeAssets(options: {
  executor: UserAnalyticsExecutor;
  queryText: string;
  assets: readonly ProjectedAsset[];
}): Promise<Map<string, AssetAccessDecision>> {
  if (options.assets.length === 0) return new Map();
  try {
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
    const raw = await options.executor.query(options.queryText, {
      assets_json: sql.string(JSON.stringify(requestRows)),
    });
    const result = QueryResultSchema.parse(raw);
    if (result.data.length !== requestRows.length) throw new AssetAuthorizationError();

    const decisions = new Map<string, AssetAccessDecision>();
    for (const row of result.data) {
      const expected = requestRows[row.ordinal];
      if (expected === undefined || expected.asset_reference !== row.asset_reference) {
        throw new AssetAuthorizationError();
      }
      if (decisions.has(row.asset_reference)) throw new AssetAuthorizationError();
      decisions.set(row.asset_reference, {
        authorized: row.can_select,
        assetType: normalizeTableType(row.asset_type),
      });
    }
    if (decisions.size !== requestRows.length) throw new AssetAuthorizationError();
    return decisions;
  } catch (error) {
    if (error instanceof AssetAuthorizationError) throw error;
    throw new AssetAuthorizationError();
  }
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
