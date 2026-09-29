import { sql } from '@databricks/appkit';

import type { ProjectedAsset } from '../domain/evidence-projection';

const MAX_BATCH_SIZE = 32;
const MAX_CONCURRENT_QUERIES = 4;
const MAX_QUERY_COUNT = 64;
const PROBE_TIMEOUT_MS = 15_000;

const ACCESS_FAILURE_MARKERS = [
  'CATALOG_NOT_FOUND',
  'INSUFFICIENT_PRIVILEGES',
  'PERMISSION_DENIED',
  'RESOURCE_DOES_NOT_EXIST',
  'SCHEMA_NOT_FOUND',
  'TABLE_OR_VIEW_NOT_FOUND',
] as const;

type StringMarker = ReturnType<typeof sql.string>;

export interface UserAnalyticsExecutor {
  query(
    queryText: string,
    parameters: Record<string, StringMarker>,
    formatParameters?: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown>;
}

export interface AssetAccessDecision {
  authorized: boolean;
  assetType: ProjectedAsset['assetType'];
}

interface ProbeState {
  decisions: Map<string, AssetAccessDecision>;
  queryCount: number;
  budgetWarningWritten: boolean;
  runLimited<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * Verify access by resolving each table under the viewer's OBO identity without
 * scanning information_schema or reading rows. Failed or unresolved assets stay
 * denied and are therefore never serialized to the browser.
 */
export async function authorizeAssets(options: {
  executor: UserAnalyticsExecutor;
  assets: readonly ProjectedAsset[];
}): Promise<Map<string, AssetAccessDecision>> {
  const decisions = new Map(
    options.assets.map((asset) => [asset.reference, { authorized: false, assetType: asset.assetType }] as const)
  );
  if (options.assets.length === 0) return decisions;

  const state: ProbeState = {
    decisions,
    queryCount: 0,
    budgetWarningWritten: false,
    runLimited: createLimiter(MAX_CONCURRENT_QUERIES),
  };
  const batches = chunk(options.assets, MAX_BATCH_SIZE);
  await Promise.all(batches.map((batch) => probeBatch(options.executor, batch, state)));
  return decisions;
}

async function probeBatch(
  executor: UserAnalyticsExecutor,
  assets: readonly ProjectedAsset[],
  state: ProbeState
): Promise<void> {
  if (assets.length === 0 || !takeQueryBudget(state)) return;
  try {
    await state.runLimited(() => executeProbe(executor, assets));
    for (const asset of assets) {
      state.decisions.set(asset.reference, { authorized: true, assetType: asset.assetType });
    }
  } catch (error) {
    if (!isAccessFailure(error)) {
      console.warn('[lineage-impact-studio] Asset access probe could not be completed', safeErrorMetadata(error));
      return;
    }
    if (assets.length === 1) return;
    const midpoint = Math.ceil(assets.length / 2);
    await Promise.all([
      probeBatch(executor, assets.slice(0, midpoint), state),
      probeBatch(executor, assets.slice(midpoint), state),
    ]);
  }
}

async function executeProbe(executor: UserAnalyticsExecutor, assets: readonly ProjectedAsset[]): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await executor.query(
      buildProbeStatement(assets.length),
      buildProbeParameters(assets),
      undefined,
      controller.signal
    );
  } finally {
    clearTimeout(timeout);
  }
}

function buildProbeStatement(assetCount: number): string {
  const branches = Array.from(
    { length: assetCount },
    (_, index) => `SELECT 1 AS access_probe FROM IDENTIFIER(:asset_${String(index)}) WHERE FALSE`
  );
  return `-- lineage-impact-studio:obo-access-probe\n${branches.join('\nUNION ALL\n')}`;
}

function buildProbeParameters(assets: readonly ProjectedAsset[]): Record<string, StringMarker> {
  return Object.fromEntries(assets.map((asset, index) => [`asset_${String(index)}`, sql.string(asset.reference)]));
}

function takeQueryBudget(state: ProbeState): boolean {
  if (state.queryCount >= MAX_QUERY_COUNT) {
    if (!state.budgetWarningWritten) {
      state.budgetWarningWritten = true;
      console.warn('[lineage-impact-studio] Asset access probe budget exhausted');
    }
    return false;
  }
  state.queryCount += 1;
  return true;
}

function isAccessFailure(error: unknown): boolean {
  return errorTokens(error).some((value) =>
    ACCESS_FAILURE_MARKERS.some((marker) => value.toUpperCase().includes(marker))
  );
}

function errorTokens(error: unknown): string[] {
  if (typeof error !== 'object' || error === null) return typeof error === 'string' ? [error] : [];
  const values: string[] = [];
  for (const field of ['code', 'errorCode', 'message', 'status']) {
    const value: unknown = Reflect.get(error, field);
    if (typeof value === 'string') values.push(value);
  }
  const cause: unknown = Reflect.get(error, 'cause');
  if (cause !== error) values.push(...errorTokens(cause));
  return values;
}

function safeErrorMetadata(error: unknown): Record<string, string | number> {
  if (typeof error !== 'object' || error === null) return { type: typeof error };
  const metadata: Record<string, string | number> = {
    type: error instanceof Error ? error.name : 'UnknownError',
  };
  for (const field of ['code', 'errorCode', 'statusCode', 'status']) {
    const value: unknown = Reflect.get(error, field);
    if (typeof value === 'string' || typeof value === 'number') metadata[field] = value;
  }
  return metadata;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const release = () => {
    active -= 1;
    queue.shift()?.();
  };

  return async function runLimited<T>(task: () => Promise<T>): Promise<T> {
    if (active >= concurrency) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}
