import { sql } from '@databricks/appkit';
import { z } from 'zod';

import type { AssessmentViewV3 } from '../domain/assessment-view';

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SQL_BATCH_SIZE = 32;
const MAX_SQL_BATCHES = 8;
const MAX_ROWS_PER_BATCH = 2_000;
const MAX_AUTH_CANDIDATES = 80;
const AUTH_CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 4_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

const EntityClassSchema = z.enum([
  'query',
  'dashboard_v3',
  'dashboard_legacy',
  'genie',
  'notebook',
  'pipeline',
  'job',
  'alert',
]);
type EntityClass = z.infer<typeof EntityClassSchema>;

const ConsumerKindSchema = z.enum(['query', 'dashboard', 'genie', 'notebook', 'pipeline', 'job', 'alert']);
type ConsumerKind = z.infer<typeof ConsumerKindSchema>;

const UsageObjectSchema = z
  .object({
    kind: ConsumerKindSchema,
    title: z.string().trim().min(1).max(256),
    url: z.url(),
    relation: z.enum(['direct', 'indirect']),
    viaAssets: z.array(z.string().min(1).max(1024)),
    accessMode: z.enum(['read', 'write', 'read_write']),
    lastObservedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const UsageAssetSchema = z
  .object({
    asset: z.string().min(1).max(1024),
    count: z.number().int().nonnegative(),
    directCount: z.number().int().nonnegative(),
    indirectCount: z.number().int().nonnegative(),
    byType: z
      .object({
        query: z.number().int().nonnegative(),
        dashboard: z.number().int().nonnegative(),
        genie: z.number().int().nonnegative(),
        notebook: z.number().int().nonnegative(),
        pipeline: z.number().int().nonnegative(),
        job: z.number().int().nonnegative(),
        alert: z.number().int().nonnegative(),
      })
      .strict(),
    complete: z.boolean(),
    objects: z.array(UsageObjectSchema),
  })
  .strict()
  .superRefine((asset, context) => {
    if (asset.count !== asset.objects.length || asset.directCount + asset.indirectCount !== asset.count) {
      context.addIssue({ code: 'custom', message: 'Usage counts do not match the visible objects.' });
    }
    const typeCount = Object.values(asset.byType).reduce((sum, value) => sum + value, 0);
    if (typeCount !== asset.count) {
      context.addIssue({ code: 'custom', message: 'Usage type counts do not match the visible objects.' });
    }
  });

export const UsageViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    assessmentReference: z.string().min(1).max(128),
    observedFrom: z.iso.datetime({ offset: true }),
    observedThrough: z.iso.datetime({ offset: true }),
    assets: z.array(UsageAssetSchema),
  })
  .strict();

export type UsageView = z.infer<typeof UsageViewSchema>;

export function serializeUsageView(value: unknown): string {
  return JSON.stringify(UsageViewSchema.parse(value));
}

export class UsageUnavailableError extends Error {
  override readonly name = 'UsageUnavailableError';

  constructor() {
    super('Live usage is unavailable.');
  }
}

export interface LineageQueryExecutor {
  query(statement: string, parameters: Record<string, ReturnType<typeof sql.string>>): Promise<unknown>;
}

interface UsageServiceOptions {
  executor: LineageQueryExecutor;
  workspaceHost: string;
  workspaceId: string;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
}

interface Observation {
  asset: string;
  entityClass: EntityClass;
  id: string;
  direct: boolean;
  read: boolean;
  write: boolean;
  lastObservedMs: number;
}

interface DraftObject {
  entityClass: EntityClass;
  id: string;
  direct: boolean;
  viaAssets: Set<string>;
  read: boolean;
  write: boolean;
  lastObservedMs: number;
}

type Visibility = { state: 'authorized'; title: string; url: string } | { state: 'denied' } | { state: 'unresolved' };

interface ConsumerIdentity {
  entityClass: EntityClass;
  id: string;
}

/**
 * Read recent lineage as the app, then resolve every consumer as the viewer
 * before placing its name, type, count, or link in the response.
 */
export class UsageService {
  readonly #executor: LineageQueryExecutor;
  readonly #workspaceHost: string;
  readonly #workspaceId: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: UsageServiceOptions) {
    this.#executor = options.executor;
    this.#workspaceHost = normalizeWorkspaceHost(options.workspaceHost);
    if (!/^\d{1,20}$/u.test(options.workspaceId)) throw new UsageUnavailableError();
    this.#workspaceId = options.workspaceId;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async getUsage(input: { view: AssessmentViewV3; oboToken: string }): Promise<UsageView> {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) throw new UsageUnavailableError();
    const observedThrough = now.toISOString();
    const observedFrom = new Date(now.getTime() - WINDOW_MS).toISOString();
    const targetAssets = [...new Set(input.view.impacts.map((impact) => impact.targetAsset))].sort();
    const { descendants, queryAssets } = authorizedReachability(input.view, targetAssets);
    const incompleteAssets = new Set<string>();
    const observations = new Map<string, Map<string, Observation>>();
    const batches = chunk(queryAssets, SQL_BATCH_SIZE);
    if (batches.length > MAX_SQL_BATCHES) {
      targetAssets.forEach((asset) => incompleteAssets.add(asset));
    }

    for (const batch of batches.slice(0, MAX_SQL_BATCHES)) {
      let rows: unknown[];
      try {
        const result = await this.#executor.query(
          buildLineageSql(batch.length),
          lineageParameters(batch, this.#workspaceId, observedFrom, observedThrough)
        );
        rows = resultRows(result);
      } catch {
        throw new UsageUnavailableError();
      }
      if (rows.length > MAX_ROWS_PER_BATCH) {
        targetAssets.forEach((asset) => incompleteAssets.add(asset));
      }
      for (const value of rows.slice(0, MAX_ROWS_PER_BATCH)) {
        const observation = parseObservation(value);
        if (observation === null || !batch.includes(observation.asset)) {
          const asset = objectStringField(value, 'asset');
          if (asset === null || !batch.includes(asset)) {
            targetAssets.forEach((candidate) => incompleteAssets.add(candidate));
          } else {
            markAffectedTargets(asset, targetAssets, descendants, incompleteAssets);
          }
          continue;
        }
        const key = `${consumerKey(observation)}:${observation.direct ? 'direct' : 'indirect'}`;
        const byConsumer = observations.get(observation.asset) ?? new Map<string, Observation>();
        const previous = byConsumer.get(key);
        byConsumer.set(
          key,
          previous === undefined
            ? observation
            : {
                ...previous,
                read: previous.read || observation.read,
                write: previous.write || observation.write,
                lastObservedMs: Math.max(previous.lastObservedMs, observation.lastObservedMs),
              }
        );
        observations.set(observation.asset, byConsumer);
      }
    }

    const drafts = buildDrafts(targetAssets, descendants, observations);
    const identities = new Map<string, ConsumerIdentity>();
    for (const byConsumer of drafts.values()) {
      for (const [key, draft] of byConsumer) {
        identities.set(key, { entityClass: draft.entityClass, id: draft.id });
      }
    }
    const orderedIdentities = [...identities].sort(([left], [right]) => left.localeCompare(right));
    const toAuthorize = orderedIdentities.slice(0, MAX_AUTH_CANDIDATES);
    if (orderedIdentities.length > MAX_AUTH_CANDIDATES) {
      const skipped = new Set(orderedIdentities.slice(MAX_AUTH_CANDIDATES).map(([key]) => key));
      for (const [asset, byConsumer] of drafts) {
        if ([...byConsumer.keys()].some((key) => skipped.has(key))) incompleteAssets.add(asset);
      }
    }
    const visibilityClient = new ConsumerVisibilityClient({
      host: this.#workspaceHost,
      workspaceId: this.#workspaceId,
      oboToken: input.oboToken,
      fetchImplementation: this.#fetch,
    });
    const authorized = new Map<string, Visibility>();
    await mapLimited(toAuthorize, AUTH_CONCURRENCY, async ([key, identity]) => {
      authorized.set(key, await visibilityClient.authorize(identity));
    });

    const assets = targetAssets.map((asset) => {
      const objects: UsageView['assets'][number]['objects'] = [];
      const byType = emptyTypeCounts();
      for (const [key, draft] of drafts.get(asset) ?? []) {
        const visibility = authorized.get(key);
        if (visibility?.state === 'unresolved' || visibility === undefined) {
          incompleteAssets.add(asset);
          continue;
        }
        if (visibility.state === 'denied') continue;
        const kind = consumerKind(draft.entityClass);
        byType[kind] += 1;
        objects.push({
          kind,
          title: visibility.title,
          url: visibility.url,
          relation: draft.direct ? 'direct' : 'indirect',
          viaAssets: draft.direct ? [] : [...draft.viaAssets].sort(),
          accessMode: draft.read && draft.write ? 'read_write' : draft.write ? 'write' : 'read',
          lastObservedAt: new Date(draft.lastObservedMs).toISOString(),
        });
      }
      objects.sort((left, right) =>
        left.kind === right.kind ? left.title.localeCompare(right.title) : left.kind.localeCompare(right.kind)
      );
      const directCount = objects.filter((object) => object.relation === 'direct').length;
      return {
        asset,
        count: objects.length,
        directCount,
        indirectCount: objects.length - directCount,
        byType,
        complete: !incompleteAssets.has(asset),
        objects,
      };
    });

    return UsageViewSchema.parse({
      schemaVersion: 1,
      assessmentReference: input.view.reference,
      observedFrom,
      observedThrough,
      assets,
    });
  }
}

function authorizedReachability(view: AssessmentViewV3, targetAssets: readonly string[]) {
  const targets = new Set(targetAssets);
  const queryAssets = new Set(targetAssets);
  const descendants = new Map(targetAssets.map((asset) => [asset, new Set<string>()] as const));
  for (const impact of view.impacts) {
    const path = impact.path;
    for (let index = 0; index < path.length; index += 1) {
      const segment = path[index];
      if (segment?.kind !== 'asset' || !targets.has(segment.reference)) continue;
      for (const downstream of path.slice(index + 1)) {
        if (downstream.kind !== 'asset' || downstream.reference === segment.reference) continue;
        descendants.get(segment.reference)?.add(downstream.reference);
        queryAssets.add(downstream.reference);
      }
    }
  }
  return { descendants, queryAssets: [...queryAssets].sort() };
}

function buildDrafts(
  targets: readonly string[],
  descendants: ReadonlyMap<string, ReadonlySet<string>>,
  observations: ReadonlyMap<string, ReadonlyMap<string, Observation>>
): Map<string, Map<string, DraftObject>> {
  const result = new Map<string, Map<string, DraftObject>>();
  for (const asset of targets) {
    const drafts = new Map<string, DraftObject>();
    for (const observation of observations.get(asset)?.values() ?? []) {
      mergeDraft(drafts, observation, observation.direct, null);
    }
    for (const downstream of descendants.get(asset) ?? []) {
      for (const observation of observations.get(downstream)?.values() ?? []) {
        mergeDraft(drafts, observation, false, downstream);
      }
    }
    result.set(asset, drafts);
  }
  return result;
}

function mergeDraft(
  drafts: Map<string, DraftObject>,
  observation: Observation,
  direct: boolean,
  viaAsset: string | null
): void {
  const key = consumerKey(observation);
  const previous = drafts.get(key);
  if (previous === undefined) {
    drafts.set(key, {
      entityClass: observation.entityClass,
      id: observation.id,
      direct,
      viaAssets: new Set(viaAsset === null ? [] : [viaAsset]),
      read: observation.read,
      write: observation.write,
      lastObservedMs: observation.lastObservedMs,
    });
    return;
  }
  if (previous.direct !== direct) {
    if (!direct) return;
    previous.direct = true;
    previous.viaAssets.clear();
    previous.read = observation.read;
    previous.write = observation.write;
    previous.lastObservedMs = observation.lastObservedMs;
    return;
  }
  if (viaAsset !== null) previous.viaAssets.add(viaAsset);
  previous.read ||= observation.read;
  previous.write ||= observation.write;
  previous.lastObservedMs = Math.max(previous.lastObservedMs, observation.lastObservedMs);
}

function markAffectedTargets(
  observedAsset: string,
  targets: readonly string[],
  descendants: ReadonlyMap<string, ReadonlySet<string>>,
  incomplete: Set<string>
): void {
  for (const target of targets) {
    if (target === observedAsset || descendants.get(target)?.has(observedAsset)) incomplete.add(target);
  }
}

function parseObservation(value: unknown): Observation | null {
  const asset = objectStringField(value, 'asset');
  const entityClassValue = objectStringField(value, 'entity_class');
  const id = objectStringField(value, 'entity_id');
  const direct = objectFlagField(value, 'has_direct');
  const read = objectFlagField(value, 'has_read');
  const write = objectFlagField(value, 'has_write');
  const lastObservedMs = objectNumberField(value, 'last_observed_ms');
  const parsedClass = EntityClassSchema.safeParse(entityClassValue);
  if (
    asset === null ||
    !parsedClass.success ||
    id === null ||
    !SAFE_ID.test(id) ||
    direct === null ||
    read === null ||
    write === null ||
    (!read && !write) ||
    lastObservedMs === null ||
    !Number.isFinite(new Date(lastObservedMs).getTime())
  ) {
    return null;
  }
  return { asset, entityClass: parsedClass.data, id, direct, read, write, lastObservedMs };
}

function objectStringField(value: unknown, field: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate: unknown = Reflect.get(value, field);
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function objectIdentifierField(value: unknown, field: string): string | null {
  const candidate = objectField(value, field);
  if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0) return String(candidate);
  return null;
}

function objectField(value: unknown, field: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, field) : null;
}

function objectFlagField(value: unknown, field: string): boolean | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate: unknown = Reflect.get(value, field);
  if (candidate === 1 || candidate === '1') return true;
  if (candidate === 0 || candidate === '0') return false;
  return null;
}

function objectNumberField(value: unknown, field: string): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate: unknown = Reflect.get(value, field);
  if (typeof candidate !== 'number' && (typeof candidate !== 'string' || !/^\d+$/u.test(candidate))) {
    return null;
  }
  const number = Number(candidate);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function resultRows(value: unknown): unknown[] {
  if (typeof value !== 'object' || value === null) throw new UsageUnavailableError();
  const data: unknown = Reflect.get(value, 'data');
  if (!Array.isArray(data)) throw new UsageUnavailableError();
  return data;
}

function consumerKey(value: ConsumerIdentity): string {
  return `${value.entityClass}:${value.id}`;
}

function consumerKind(entityClass: EntityClass): ConsumerKind {
  return entityClass === 'dashboard_v3' || entityClass === 'dashboard_legacy' ? 'dashboard' : entityClass;
}

function emptyTypeCounts(): Record<ConsumerKind, number> {
  return { query: 0, dashboard: 0, genie: 0, notebook: 0, pipeline: 0, job: 0, alert: 0 };
}

function lineageParameters(
  assets: readonly string[],
  workspaceId: string,
  observedFrom: string,
  observedThrough: string
): Record<string, ReturnType<typeof sql.string>> {
  return {
    workspace_id: sql.string(workspaceId),
    observed_from: sql.string(observedFrom),
    observed_through: sql.string(observedThrough),
    ...Object.fromEntries(assets.map((asset, index) => [`asset_${String(index)}`, sql.string(asset)])),
  };
}

export function buildLineageSql(assetCount: number): string {
  if (!Number.isInteger(assetCount) || assetCount < 1 || assetCount > SQL_BATCH_SIZE) throw new UsageUnavailableError();
  const assetMarkers = Array.from({ length: assetCount }, (_, index) => `:asset_${String(index)}`).join(', ');
  return `-- lineage-impact-studio:visible-consumer-usage
WITH selected_assets AS (
  SELECT explode(array(${assetMarkers})) AS asset
), matched AS (
  SELECT
    selected_assets.asset,
    CASE WHEN lineage.source_table_full_name = selected_assets.asset THEN 1 ELSE 0 END AS reads_asset,
    CASE WHEN lineage.target_table_full_name = selected_assets.asset THEN 1 ELSE 0 END AS writes_asset,
    lineage.direct_access,
    lineage.event_time,
    lineage.entity_type,
    lineage.entity_id AS lineage_entity_id,
    lineage.entity_metadata
  FROM system.access.table_lineage AS lineage
  INNER JOIN selected_assets
    ON lineage.source_table_full_name = selected_assets.asset
    OR lineage.target_table_full_name = selected_assets.asset
  WHERE lineage.workspace_id = CAST(:workspace_id AS BIGINT)
    AND lineage.event_date >= date_sub(current_date(), 31)
    AND lineage.event_time >= CAST(:observed_from AS TIMESTAMP)
    AND lineage.event_time <= CAST(:observed_through AS TIMESTAMP)
), expanded AS (
  SELECT matched.*, consumer.entity_class, consumer.entity_id AS consumer_id
  FROM matched
  LATERAL VIEW explode(array(
    named_struct('entity_class', 'query', 'entity_id',
      coalesce(nullif(CAST(entity_metadata.sql_query_id AS STRING), ''),
        CASE WHEN entity_type = 'DBSQL_QUERY' THEN CAST(lineage_entity_id AS STRING) END)),
    named_struct('entity_class', 'dashboard_v3', 'entity_id',
      coalesce(nullif(CAST(entity_metadata.dashboard_id AS STRING), ''),
        CASE WHEN entity_type = 'DASHBOARD_V3' THEN CAST(lineage_entity_id AS STRING) END)),
    named_struct('entity_class', 'dashboard_legacy', 'entity_id',
      coalesce(nullif(CAST(entity_metadata.legacy_dashboard_id AS STRING), ''),
        CASE WHEN entity_type = 'DBSQL_DASHBOARD' THEN CAST(lineage_entity_id AS STRING) END)),
    named_struct('entity_class', 'genie', 'entity_id', CAST(entity_metadata.genie_space_id AS STRING)),
    named_struct('entity_class', 'notebook', 'entity_id',
      coalesce(nullif(CAST(entity_metadata.notebook_id AS STRING), ''),
        CASE WHEN entity_type = 'NOTEBOOK' THEN CAST(lineage_entity_id AS STRING) END)),
    named_struct('entity_class', 'pipeline', 'entity_id',
      coalesce(nullif(CAST(entity_metadata.dlt_pipeline_info.dlt_pipeline_id AS STRING), ''),
        CASE WHEN entity_type = 'PIPELINE' THEN CAST(lineage_entity_id AS STRING) END)),
    named_struct('entity_class', 'job', 'entity_id',
      CASE WHEN entity_metadata.dashboard_id IS NOT NULL
          OR entity_metadata.legacy_dashboard_id IS NOT NULL
          OR entity_type IN ('DASHBOARD_V3', 'DBSQL_DASHBOARD')
        THEN NULL
        ELSE coalesce(nullif(CAST(entity_metadata.job_info.job_id AS STRING), ''),
          CASE WHEN entity_type = 'JOB' THEN CAST(lineage_entity_id AS STRING) END)
      END),
    named_struct('entity_class', 'alert', 'entity_id', CAST(entity_metadata.alert_id AS STRING))
  )) exploded AS consumer
), classified AS (
  SELECT expanded.*,
    CASE WHEN writes_asset = 1 OR (reads_asset = 1 AND direct_access = TRUE) THEN 1 ELSE 0 END AS direct_observation
  FROM expanded
)
SELECT
  asset,
  entity_class,
  consumer_id AS entity_id,
  direct_observation AS has_direct,
  MAX(reads_asset) AS has_read,
  MAX(writes_asset) AS has_write,
  unix_millis(MAX(event_time)) AS last_observed_ms
FROM classified
WHERE consumer_id IS NOT NULL AND consumer_id <> ''
GROUP BY asset, entity_class, consumer_id, direct_observation
ORDER BY asset, entity_class, consumer_id, direct_observation DESC
LIMIT ${String(MAX_ROWS_PER_BATCH + 1)}`;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function mapLimited<T>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) await action(value);
      }
    })
  );
}

function normalizeWorkspaceHost(value: string): string {
  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    throw new UsageUnavailableError();
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new UsageUnavailableError();
  }
  return url.origin;
}

type JsonResponse = { state: 'ok'; body: unknown } | { state: 'denied' } | { state: 'unresolved' };

type VisibilityDiagnosticReason =
  | 'scope_denied'
  | 'access_denied'
  | 'not_found'
  | 'authentication_failed'
  | 'rate_limited'
  | 'http_error'
  | 'response_too_large'
  | 'invalid_json'
  | 'timeout'
  | 'network_error'
  | 'id_mismatch'
  | 'invalid_response'
  | 'viewer_unavailable'
  | 'viewer_grant_unresolved';

type ScopeHint = 'jobs' | 'pipelines' | 'access-management' | 'dashboards' | 'all-apis' | 'unknown';
type VisibilityDiagnosticCallback = (status: number, reason: VisibilityDiagnosticReason, scopeHint?: ScopeHint) => void;

class ConsumerVisibilityClient {
  readonly #host: string;
  readonly #workspaceId: string;
  readonly #oboToken: string;
  readonly #fetch: typeof fetch;
  #userNamePromise: Promise<string | null> | null = null;

  constructor(options: { host: string; workspaceId: string; oboToken: string; fetchImplementation: typeof fetch }) {
    this.#host = options.host;
    this.#workspaceId = options.workspaceId;
    this.#oboToken = options.oboToken;
    this.#fetch = options.fetchImplementation;
  }

  async authorize(identity: ConsumerIdentity): Promise<Visibility> {
    const { entityClass, id } = identity;
    if (!SAFE_ID.test(id)) return { state: 'unresolved' };
    switch (entityClass) {
      case 'query':
        return this.#authorizeObject(
          `/api/2.0/sql/queries/${encodeURIComponent(id)}`,
          id,
          ['id'],
          'Query',
          `${this.#host}/sql/queries/${encodeURIComponent(id)}`
        );
      case 'genie': {
        const url = `${this.#host}/genie/rooms/${encodeURIComponent(id)}`;
        const checks: Array<{ probe: 'get' | 'acl'; status: number; reason: VisibilityDiagnosticReason }> = [];
        const recordGet: VisibilityDiagnosticCallback = (status, reason) =>
          checks.push({ probe: 'get', status, reason });
        const recordAcl: VisibilityDiagnosticCallback = (status, reason) =>
          checks.push({ probe: 'acl', status, reason });
        const direct = await this.#authorizeObject(
          `/api/2.0/genie/spaces/${encodeURIComponent(id)}`,
          id,
          ['space_id'],
          'Genie room',
          url,
          recordGet
        );
        if (direct.state === 'authorized') return direct;
        const fallback = await this.#authorizeAcl('genie', id, 'Genie room', url, recordAcl);
        if (fallback.state !== 'authorized') {
          // Only fixed labels, numeric statuses, and fixed reasons enter the log.
          console.info(
            '[lineage-impact-studio] Genie visibility diagnostic',
            JSON.stringify({
              outcome: fallback.state,
              checks,
            })
          );
        }
        return fallback;
      }
      case 'dashboard_v3': {
        const url = `${this.#host}/dashboardsv3/${encodeURIComponent(id)}/published?w=${encodeURIComponent(this.#workspaceId)}`;
        const direct = await this.#authorizeObject(
          `/api/2.0/lakeview/dashboards/${encodeURIComponent(id)}`,
          id,
          ['dashboard_id'],
          'Dashboard',
          url
        );
        return direct.state === 'authorized'
          ? direct
          : this.#authorizeAclWithDiagnostics('dashboards', id, 'Dashboard', url);
      }
      case 'dashboard_legacy': {
        const url = `${this.#host}/sql/dashboards/${encodeURIComponent(id)}`;
        const direct = await this.#authorizeObject(
          `/api/2.0/preview/sql/dashboards/${encodeURIComponent(id)}`,
          id,
          ['id', 'dashboard_id'],
          'Dashboard',
          url
        );
        return direct.state === 'authorized' ? direct : this.#authorizeAcl('dbsql-dashboards', id, 'Dashboard', url);
      }
      case 'notebook':
        return this.#authorizeAcl(
          'notebooks',
          id,
          'Notebook',
          `${this.#host}/?o=${encodeURIComponent(this.#workspaceId)}#notebook/${encodeURIComponent(id)}`
        );
      case 'pipeline':
        return this.#authorizeAclWithDiagnostics(
          'pipelines',
          id,
          'Pipeline',
          `${this.#host}/pipelines/${encodeURIComponent(id)}`
        );
      case 'job':
        return this.#authorizeAclWithDiagnostics('jobs', id, 'Job', `${this.#host}/jobs/${encodeURIComponent(id)}`);
      case 'alert': {
        const url = `${this.#host}/sql/alerts/${encodeURIComponent(id)}`;
        const direct = await this.#authorizeObject(
          `/api/2.0/sql/alerts/${encodeURIComponent(id)}`,
          id,
          ['id'],
          'Alert',
          url
        );
        return direct.state === 'authorized' ? direct : this.#authorizeAcl('alertsv2', id, 'Alert', url);
      }
    }
  }

  async #authorizeObject(
    path: string,
    expectedId: string,
    idFields: readonly string[],
    typeLabel: string,
    url: string,
    diagnostic?: VisibilityDiagnosticCallback
  ): Promise<Visibility> {
    const result = await this.#request(path, diagnostic);
    if (result.state !== 'ok') return result;
    const matchingId = idFields.some(
      (field) => objectStringField(result.body, field)?.toLowerCase() === expectedId.toLowerCase()
    );
    if (!matchingId) {
      diagnostic?.(200, 'id_mismatch');
      return { state: 'unresolved' };
    }
    const title = safeTitle(
      objectStringField(result.body, 'display_name') ??
        objectStringField(result.body, 'title') ??
        objectStringField(result.body, 'name')
    );
    return { state: 'authorized', title: title ?? `${typeLabel} ${expectedId}`, url };
  }

  async #authorizeAclWithDiagnostics(
    objectType: string,
    id: string,
    typeLabel: string,
    url: string
  ): Promise<Visibility> {
    const checks: Array<{ status: number; reason: VisibilityDiagnosticReason; scopeHint?: ScopeHint }> = [];
    const result = await this.#authorizeAcl(objectType, id, typeLabel, url, (status, reason, scopeHint) => {
      checks.push({ status, reason, ...(scopeHint === undefined ? {} : { scopeHint }) });
    });
    if (result.state !== 'authorized') {
      // IDs, titles, token contents, and service responses never enter this log.
      console.info(
        '[lineage-impact-studio] Consumer visibility diagnostic',
        JSON.stringify({ kind: objectType, outcome: result.state, checks })
      );
    }
    return result;
  }

  async #authorizeAcl(
    objectType: string,
    id: string,
    typeLabel: string,
    url: string,
    diagnostic?: VisibilityDiagnosticCallback
  ): Promise<Visibility> {
    const userName = await this.#userName();
    if (userName === null) {
      diagnostic?.(0, 'viewer_unavailable');
      return { state: 'unresolved' };
    }
    const result = await this.#request(`/api/2.0/permissions/${objectType}/${encodeURIComponent(id)}`, diagnostic);
    if (result.state !== 'ok') return result;
    if (typeof result.body !== 'object' || result.body === null) {
      diagnostic?.(200, 'invalid_response');
      return { state: 'unresolved' };
    }
    if (!aclResponseMatches(result.body, objectType, id)) {
      diagnostic?.(200, 'id_mismatch');
      return { state: 'unresolved' };
    }
    const entries: unknown = Reflect.get(result.body, 'access_control_list');
    if (!Array.isArray(entries)) {
      diagnostic?.(200, 'invalid_response');
      return { state: 'unresolved' };
    }
    const matching = entries.filter((entry) => objectStringField(entry, 'user_name')?.toLowerCase() === userName);
    if (matching.length === 0) {
      diagnostic?.(200, 'viewer_grant_unresolved');
      return { state: 'unresolved' };
    }
    const canRead = matching.some((entry) => {
      if (typeof entry !== 'object' || entry === null) return false;
      const permissions: unknown = Reflect.get(entry, 'all_permissions');
      return (
        Array.isArray(permissions) &&
        permissions.some((permission) => {
          const level = objectStringField(permission, 'permission_level');
          return level !== null && VIEW_PERMISSION_LEVELS.has(level);
        })
      );
    });
    if (!canRead) {
      diagnostic?.(200, 'viewer_grant_unresolved');
      return { state: 'unresolved' };
    }
    const title = await this.#aclGrantedTitle(objectType, id);
    return { state: 'authorized', title: title ?? `${typeLabel} ${id}`, url };
  }

  async #aclGrantedTitle(objectType: string, id: string): Promise<string | null> {
    let path: string;
    if (objectType === 'jobs') {
      path = `/api/2.1/jobs/get?job_id=${encodeURIComponent(id)}`;
    } else if (objectType === 'pipelines') {
      path = `/api/2.0/pipelines/${encodeURIComponent(id)}`;
    } else {
      return null;
    }
    const result = await this.#request(path);
    if (result.state !== 'ok') return null;
    const returnedId = objectIdentifierField(result.body, objectType === 'jobs' ? 'job_id' : 'pipeline_id');
    if (returnedId?.toLowerCase() !== id.toLowerCase()) return null;
    const nested = objectField(result.body, objectType === 'jobs' ? 'settings' : 'spec');
    return safeTitle(objectStringField(nested, 'name') ?? objectStringField(result.body, 'name'));
  }

  async #userName(): Promise<string | null> {
    this.#userNamePromise ??= this.#loadUserName();
    return this.#userNamePromise;
  }

  async #loadUserName(): Promise<string | null> {
    const result = await this.#request('/api/2.0/preview/scim/v2/Me');
    if (result.state !== 'ok') return null;
    return objectStringField(result.body, 'userName')?.toLowerCase() ?? null;
  }

  async #request(path: string, diagnostic?: VisibilityDiagnosticCallback): Promise<JsonResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.#fetch(`${this.#host}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.#oboToken}`, Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        diagnostic?.(response.status, 'response_too_large');
        return { state: 'unresolved' };
      }
      const bodyText = await response.text();
      if (bodyText.length > MAX_RESPONSE_BYTES) {
        diagnostic?.(response.status, 'response_too_large');
        return { state: 'unresolved' };
      }
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        diagnostic?.(response.status, 'invalid_json');
        return { state: 'unresolved' };
      }
      if (response.ok) {
        return { state: 'ok', body };
      }
      const reason = requestFailureReason(response.status, body);
      diagnostic?.(response.status, reason, reason === 'scope_denied' ? requiredScopeHint(body) : undefined);
      return { state: classifyFailedRequest(response.status, body) };
    } catch {
      diagnostic?.(0, controller.signal.aborted ? 'timeout' : 'network_error');
      return { state: 'unresolved' };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Permissions API responses use singular types and resource paths for some objects. */
function aclResponseMatches(body: unknown, objectType: string, id: string): boolean {
  const responseType = objectStringField(body, 'object_type');
  const responseId = objectIdentifierField(body, 'object_id')?.toLowerCase();
  const expectedType = objectType === 'jobs' ? 'job' : objectType === 'dashboards' ? 'dashboard' : objectType;
  if (responseType !== expectedType && responseType !== objectType) return false;
  if (responseId === undefined || responseId === null) return false;
  // Lakeview permission lookups accept a dashboard UUID but return the mapped
  // workspace object's numeric ID. The OBO request is bound to the UUID.
  if (objectType === 'dashboards') return /^\/dashboards\/[1-9][0-9]*$/u.test(responseId);
  const normalizedId = id.toLowerCase();
  return responseId === normalizedId || responseId === `/${objectType}/${normalizedId}`;
}

const VIEW_PERMISSION_LEVELS = new Set([
  'CAN_VIEW',
  'CAN_READ',
  'CAN_RUN',
  'CAN_USE',
  'CAN_QUERY',
  'CAN_MANAGE_RUN',
  'CAN_EDIT',
  'CAN_MANAGE',
  'IS_OWNER',
]);

function requestFailureReason(status: number, body: unknown): VisibilityDiagnosticReason {
  if (status === 401) return 'authentication_failed';
  if (status === 403) {
    const message = objectStringField(body, 'message')?.toLowerCase() ?? '';
    return message.includes('scope') ? 'scope_denied' : 'access_denied';
  }
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'http_error';
}

function requiredScopeHint(body: unknown): ScopeHint {
  const message = objectStringField(body, 'message')?.toLowerCase() ?? '';
  const scope = /(?:required|missing|allowed)\s+(?:api\s+)?scopes?\s*:?\s*['"`]?([a-z][a-z0-9:.-]*)/u.exec(
    message
  )?.[1];
  if (
    scope === 'jobs' ||
    scope === 'pipelines' ||
    scope === 'access-management' ||
    scope === 'dashboards' ||
    scope === 'all-apis'
  ) {
    return scope;
  }
  return 'unknown';
}

function classifyFailedRequest(status: number, body: unknown): 'denied' | 'unresolved' {
  const code = objectStringField(body, 'error_code') ?? objectStringField(body, 'errorCode');
  const message = objectStringField(body, 'message')?.toLowerCase() ?? '';
  if (status === 404 && code !== null && NOT_FOUND_CODES.has(code)) return 'denied';
  if (status === 403 && code === 'INSUFFICIENT_PRIVILEGES' && !message.includes('scope')) return 'denied';
  return 'unresolved';
}

const NOT_FOUND_CODES = new Set([
  'RESOURCE_DOES_NOT_EXIST',
  'RESOURCE_NOT_FOUND',
  'QUERY_NOT_FOUND',
  'DASHBOARD_NOT_FOUND',
  'SPACE_NOT_FOUND',
  'ALERT_NOT_FOUND',
]);

function safeTitle(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return null;
  for (const character of trimmed) {
    const point = character.codePointAt(0) ?? 0;
    if (point <= 0x1f || point === 0x7f || point === 0x2028 || point === 0x2029) return null;
  }
  return trimmed;
}
