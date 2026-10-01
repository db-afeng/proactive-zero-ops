import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssessmentViewV3Schema } from '../domain/assessment-view';
import { UsageService, UsageUnavailableError, buildLineageSql, type LineageQueryExecutor } from './usage-service';

const REFERENCE = 'lgr_0123456789abcdefghijklmnopqrstuv';
const ROOT = 'catalog.schema.source';
const ALPHA = 'catalog.schema.alpha';
const BETA = 'catalog.schema.beta';
const GAMMA = 'catalog.schema.gamma';
const NOW = new Date('2026-10-01T00:00:00.000Z');
const EARLY = Date.parse('2026-09-29T10:00:00.000Z');
const LATE = Date.parse('2026-09-30T10:00:00.000Z');
const TOKEN = 'viewer-obo-token-with-at-least-20-chars';

function assessment(paths: readonly (readonly string[])[]) {
  return AssessmentViewV3Schema.parse({
    schemaVersion: 3,
    reference: REFERENCE,
    detailState: 'available',
    status: 'block',
    severity: 'high',
    message: 'A potentially breaking downstream impact was identified.',
    headline: 'A source column changed type.',
    recommendedAction: 'Review the affected assets.',
    source: {
      provider: 'github',
      createdAt: '2026-09-30T00:00:00.000Z',
      freshness: 'current',
      evidenceOrigin: 'observed_lineage',
    },
    pullRequest: {
      repository: 'example/project',
      number: 1,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    },
    viewer: { subject: 'viewer-id', displayName: 'viewer@example.com' },
    confidence: { interpretation: 0.9, discovery: 'complete' },
    changes: [
      {
        id: 'change-1',
        asset: ROOT,
        column: 'amount',
        changeKind: 'modified',
        beforeType: 'numeric',
        afterType: 'text',
      },
    ],
    impacts: paths.map((path, index) => ({
      id: `impact-${String(index + 1)}`,
      changeId: 'change-1',
      relation: 'transitive',
      targetAsset: path[path.length - 1],
      targetColumn: null,
      operation: 'arithmetic',
      reason: 'incompatible_type',
      evidenceLevel: 'lineage',
      path: path.map((reference) => ({ kind: 'asset', reference, assetType: 'table' })),
      remediation: 'restore_contract',
    })),
    graph: { nodes: [], edges: [] },
    disclosure: { state: 'full', notice: 'All referenced lineage assets are visible to you.' },
  });
}

function observation(input: {
  asset: string;
  entityClass: string;
  id: string;
  direct?: number;
  read?: number;
  write?: number;
  observed?: number;
}) {
  return {
    asset: input.asset,
    entity_class: input.entityClass,
    entity_id: input.id,
    has_direct: input.direct ?? 1,
    has_read: input.read ?? 1,
    has_write: input.write ?? 0,
    last_observed_ms: input.observed ?? LATE,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function responseFor(path: string): Response {
  if (path === '/api/2.0/sql/queries/q1') return jsonResponse(200, { id: 'q1', display_name: 'Daily query' });
  if (path === '/api/2.0/lakeview/dashboards/d1') {
    return jsonResponse(200, { dashboard_id: 'd1', display_name: 'Risk dashboard' });
  }
  if (path === '/api/2.0/genie/spaces/g1') return jsonResponse(200, { space_id: 'g1', title: 'Risk Genie' });
  return jsonResponse(404, { error_code: 'RESOURCE_DOES_NOT_EXIST' });
}

function fetchUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === 'string' ? input : input.url);
}

function service(
  rows: unknown[],
  fetchImplementation: typeof fetch = (input) => Promise.resolve(responseFor(fetchUrl(input).pathname))
) {
  const query = vi.fn((_statement: string, _parameters: Parameters<LineageQueryExecutor['query']>[1]) =>
    Promise.resolve({ data: rows })
  );
  const executor: LineageQueryExecutor = { query };
  return {
    studio: new UsageService({
      executor,
      workspaceHost: 'workspace.example.com',
      workspaceId: '123456789',
      fetchImplementation,
      now: () => NOW,
    }),
    query,
  };
}

describe('UsageService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('counts multiple named objects from one lineage event once despite repeated column observations', async () => {
    const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchImplementation = vi.fn<typeof fetch>((input) => Promise.resolve(responseFor(fetchUrl(input).pathname)));
    const { studio } = service(
      [
        observation({ asset: ALPHA, entityClass: 'query', id: 'q1', observed: EARLY }),
        observation({ asset: ALPHA, entityClass: 'query', id: 'q1', observed: EARLY }),
        observation({ asset: ALPHA, entityClass: 'dashboard_v3', id: 'd1', observed: EARLY }),
        observation({ asset: ALPHA, entityClass: 'genie', id: 'g1', observed: EARLY }),
      ],
      fetchImplementation
    );
    const usage = await studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN });

    expect(usage.assets[0]).toMatchObject({
      count: 3,
      directCount: 3,
      indirectCount: 0,
      byType: { query: 1, dashboard: 1, genie: 1 },
      complete: true,
    });
    expect(usage.assets[0]?.objects.map(({ title }) => title).sort()).toEqual([
      'Daily query',
      'Risk Genie',
      'Risk dashboard',
    ]);
    expect(fetchImplementation.mock.calls.map(([input]) => fetchUrl(input).pathname).sort()).toEqual([
      '/api/2.0/genie/spaces/g1',
      '/api/2.0/lakeview/dashboards/d1',
      '/api/2.0/sql/queries/q1',
    ]);
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it('deduplicates consumers across authorized downstream paths and prefers direct usage', async () => {
    const { studio, query } = service([
      observation({ asset: ALPHA, entityClass: 'query', id: 'q1' }),
      observation({ asset: BETA, entityClass: 'query', id: 'q1' }),
      observation({ asset: BETA, entityClass: 'dashboard_v3', id: 'd1' }),
      observation({ asset: GAMMA, entityClass: 'dashboard_v3', id: 'd1' }),
      observation({ asset: GAMMA, entityClass: 'genie', id: 'g1' }),
    ]);
    const usage = await studio.getUsage({
      view: assessment([
        [ROOT, ALPHA],
        [ROOT, ALPHA, BETA],
        [ROOT, ALPHA, GAMMA],
      ]),
      oboToken: TOKEN,
    });

    expect(query).toHaveBeenCalledOnce();
    const [statement, parameters] = query.mock.calls[0] ?? [];
    expect(statement).toContain('system.access.table_lineage');
    expect(JSON.stringify(parameters)).toContain(ALPHA);
    expect(JSON.stringify(parameters)).toContain(BETA);
    expect(JSON.stringify(parameters)).toContain(GAMMA);
    expect(usage.assets.map(({ asset, count }) => [asset, count])).toEqual([
      [ALPHA, 3],
      [BETA, 2],
      [GAMMA, 2],
    ]);
    const alpha = usage.assets[0];
    expect(alpha).toMatchObject({ directCount: 1, indirectCount: 2, complete: true });
    expect(alpha?.objects.find((item) => item.kind === 'query')).toMatchObject({
      title: 'Daily query',
      relation: 'direct',
      viaAssets: [],
    });
    expect(alpha?.objects.find((item) => item.kind === 'dashboard')).toMatchObject({
      title: 'Risk dashboard',
      url: 'https://workspace.example.com/dashboardsv3/d1/published?w=123456789',
      relation: 'indirect',
      viaAssets: [BETA, GAMMA],
    });
    expect(alpha?.objects.find((item) => item.kind === 'genie')).toMatchObject({
      title: 'Risk Genie',
      relation: 'indirect',
      viaAssets: [GAMMA],
    });
  });

  it('keeps a direct read and its timestamp separate from a later downstream write', async () => {
    const { studio } = service([
      observation({ asset: ALPHA, entityClass: 'query', id: 'q1', direct: 1, read: 1, write: 0, observed: EARLY }),
      observation({ asset: BETA, entityClass: 'query', id: 'q1', direct: 1, read: 0, write: 1, observed: LATE }),
    ]);
    const usage = await studio.getUsage({
      view: assessment([
        [ROOT, ALPHA],
        [ROOT, ALPHA, BETA],
      ]),
      oboToken: TOKEN,
    });

    expect(usage.assets[0]?.objects[0]).toMatchObject({
      relation: 'direct',
      accessMode: 'read',
      lastObservedAt: '2026-09-29T10:00:00.000Z',
      viaAssets: [],
    });
    expect(usage.assets[1]?.objects[0]).toMatchObject({
      relation: 'direct',
      accessMode: 'write',
      lastObservedAt: '2026-09-30T10:00:00.000Z',
    });
  });

  it('prefers a direct observation over a later indirect observation on the same asset', async () => {
    const { studio } = service([
      observation({ asset: ALPHA, entityClass: 'query', id: 'q1', direct: 0, observed: LATE }),
      observation({ asset: ALPHA, entityClass: 'query', id: 'q1', direct: 1, observed: EARLY }),
    ]);
    const usage = await studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN });

    expect(usage.assets[0]).toMatchObject({ count: 1, directCount: 1, complete: true });
    expect(usage.assets[0]?.objects[0]).toMatchObject({
      relation: 'direct',
      accessMode: 'read',
      lastObservedAt: '2026-09-29T10:00:00.000Z',
    });
  });

  it('combines modes and timestamps across downstream assets for an indirect consumer', async () => {
    const { studio } = service([
      observation({ asset: BETA, entityClass: 'query', id: 'q1', read: 1, write: 0, observed: EARLY }),
      observation({ asset: GAMMA, entityClass: 'query', id: 'q1', read: 0, write: 1, observed: LATE }),
    ]);
    const usage = await studio.getUsage({
      view: assessment([
        [ROOT, ALPHA],
        [ROOT, ALPHA, BETA],
        [ROOT, ALPHA, GAMMA],
      ]),
      oboToken: TOKEN,
    });

    expect(usage.assets[0]?.objects[0]).toMatchObject({
      relation: 'indirect',
      accessMode: 'read_write',
      lastObservedAt: '2026-09-30T10:00:00.000Z',
      viaAssets: [BETA, GAMMA],
    });
  });

  it('combines read and write observations and retains the latest timestamp', async () => {
    const { studio } = service([
      observation({ asset: ALPHA, entityClass: 'query', id: 'q1', read: 1, write: 0, observed: EARLY }),
      observation({ asset: ALPHA, entityClass: 'query', id: 'q1', read: 0, write: 1, observed: LATE }),
    ]);
    const usage = await studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN });
    expect(usage.assets[0]).toMatchObject({ count: 1, directCount: 1, byType: { query: 1 } });
    expect(usage.assets[0]?.objects[0]).toMatchObject({
      accessMode: 'read_write',
      lastObservedAt: '2026-09-30T10:00:00.000Z',
    });
  });

  it('classifies a view-mediated table read as indirect even without a downstream asset', async () => {
    const { studio } = service([observation({ asset: ALPHA, entityClass: 'query', id: 'q1', direct: 0, read: 1 })]);
    const usage = await studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN });

    expect(usage.assets[0]).toMatchObject({ count: 1, directCount: 0, indirectCount: 1, complete: true });
    expect(usage.assets[0]?.objects[0]).toMatchObject({
      relation: 'indirect',
      viaAssets: [],
      accessMode: 'read',
    });
  });

  it('binds this workspace, authorized paths, and the exact 30-day observation window', async () => {
    const { studio, query } = service([]);
    const usage = await studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN });
    const [statement, parameters] = query.mock.calls[0] ?? [];
    const boundValues = JSON.stringify(parameters);

    expect(statement).toMatch(/lineage\.workspace_id = CAST\(:workspace_id AS BIGINT\)/u);
    expect(statement).toMatch(/lineage\.event_time >= CAST\(:observed_from AS TIMESTAMP\)/u);
    expect(statement).toMatch(/lineage\.event_time <= CAST\(:observed_through AS TIMESTAMP\)/u);
    expect(statement).toContain('INNER JOIN selected_assets');
    expect(statement).not.toContain(ALPHA);
    expect(boundValues).toContain('123456789');
    expect(boundValues).toContain(ALPHA);
    expect(boundValues).not.toContain(BETA);
    expect(usage).toMatchObject({
      observedFrom: '2026-09-01T00:00:00.000Z',
      observedThrough: '2026-10-01T00:00:00.000Z',
    });
    expect(boundValues).toContain(usage.observedFrom);
    expect(boundValues).toContain(usage.observedThrough);
  });

  it('expands each stable metadata ID and filters anonymous statements before aggregation', () => {
    const statement = buildLineageSql(1);
    const classes = [...statement.matchAll(/named_struct\('entity_class', '([^']+)'/gu)].map((match) => match[1]);

    expect(statement).toContain('LATERAL VIEW explode(array(');
    expect(classes).toEqual([
      'query',
      'dashboard_v3',
      'dashboard_legacy',
      'genie',
      'notebook',
      'pipeline',
      'job',
      'alert',
    ]);
    expect(statement).toContain("CASE WHEN entity_type = 'DBSQL_QUERY' THEN CAST(lineage_entity_id AS STRING) END");
    expect(statement).toContain("WHERE consumer_id IS NOT NULL AND consumer_id <> ''");
    expect(statement).toContain('GROUP BY asset, entity_class, consumer_id, direct_observation');
  });

  it('omits clear OBO denials and labels unresolved checks as partial', async () => {
    const fetchImplementation: typeof fetch = (input) => {
      const path = fetchUrl(input).pathname;
      if (path.endsWith('/denied')) {
        return Promise.resolve(jsonResponse(403, { error_code: 'INSUFFICIENT_PRIVILEGES', message: 'Access denied' }));
      }
      return Promise.resolve(jsonResponse(429, { error_code: 'RESOURCE_EXHAUSTED' }));
    };
    const { studio } = service(
      [
        observation({ asset: ALPHA, entityClass: 'query', id: 'denied' }),
        observation({ asset: ALPHA, entityClass: 'query', id: 'unknown' }),
      ],
      fetchImplementation
    );
    const usage = await studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN });
    expect(usage.assets[0]).toMatchObject({ count: 0, complete: false, objects: [] });
    expect(JSON.stringify(usage)).not.toContain('denied');
    expect(JSON.stringify(usage)).not.toContain('unknown');
  });

  it('excludes a denied object without reducing the verified count or exposing its identity', async () => {
    const fetchImplementation: typeof fetch = (input) =>
      Promise.resolve(
        fetchUrl(input).pathname.endsWith('/private-query-id')
          ? jsonResponse(403, { error_code: 'INSUFFICIENT_PRIVILEGES', message: 'Access denied' })
          : responseFor(fetchUrl(input).pathname)
      );
    const { studio } = service(
      [
        observation({ asset: ALPHA, entityClass: 'query', id: 'q1' }),
        observation({ asset: ALPHA, entityClass: 'query', id: 'private-query-id' }),
      ],
      fetchImplementation
    );
    const usage = await studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN });

    expect(usage.assets[0]).toMatchObject({ count: 1, complete: true, byType: { query: 1 } });
    expect(usage.assets[0]?.objects).toEqual([
      expect.objectContaining({ title: 'Daily query', url: 'https://workspace.example.com/sql/queries/q1' }),
    ]);
    expect(JSON.stringify(usage)).not.toContain('private-query-id');
  });

  it('distinguishes a verified zero from malformed lineage and carries partial status upstream', async () => {
    const complete = await service([]).studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN });
    expect(complete.assets[0]).toMatchObject({ count: 0, complete: true });

    const malformed = observation({ asset: BETA, entityClass: 'query', id: 'q1' });
    const { studio } = service([{ ...malformed, entity_id: 'bad/id' }]);
    const partial = await studio.getUsage({
      view: assessment([
        [ROOT, ALPHA],
        [ROOT, ALPHA, BETA],
        [ROOT, GAMMA],
      ]),
      oboToken: TOKEN,
    });
    expect(partial.assets.map(({ asset, complete }) => [asset, complete])).toEqual([
      [ALPHA, false],
      [BETA, false],
      [GAMMA, true],
    ]);
  });

  it('uses explicit viewer ACL grants, enriches job and pipeline titles, and leaves missing grants partial', async () => {
    const paths: string[] = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      const url = fetchUrl(input);
      paths.push(`${url.pathname}${url.search}`);
      if (url.pathname.endsWith('/Me')) return Promise.resolve(jsonResponse(200, { userName: 'Viewer@Example.com' }));
      if (url.pathname === '/api/2.0/permissions/jobs/42') {
        return Promise.resolve(
          jsonResponse(200, {
            object_id: '/jobs/42',
            object_type: 'job',
            access_control_list: [
              { user_name: 'viewer@example.com', all_permissions: [{ permission_level: 'CAN_VIEW' }] },
            ],
          })
        );
      }
      if (url.pathname === '/api/2.0/permissions/pipelines/p1') {
        return Promise.resolve(
          jsonResponse(200, {
            object_id: '/pipelines/p1',
            object_type: 'pipelines',
            access_control_list: [
              { user_name: 'viewer@example.com', all_permissions: [{ permission_level: 'CAN_VIEW' }] },
            ],
          })
        );
      }
      if (url.pathname === '/api/2.0/permissions/notebooks/99') {
        return Promise.resolve(
          jsonResponse(200, {
            object_id: '99',
            object_type: 'notebooks',
            access_control_list: [{ group_name: 'viewers', all_permissions: [{ permission_level: 'CAN_READ' }] }],
          })
        );
      }
      if (url.pathname === '/api/2.1/jobs/get')
        return Promise.resolve(jsonResponse(200, { job_id: 42, settings: { name: 'Daily risk job' } }));
      if (url.pathname === '/api/2.0/pipelines/p1')
        return Promise.resolve(jsonResponse(200, { pipeline_id: 'p1', spec: { name: 'Risk pipeline' } }));
      return Promise.resolve(jsonResponse(404, { error_code: 'RESOURCE_DOES_NOT_EXIST' }));
    };
    const { studio } = service(
      [
        observation({ asset: ALPHA, entityClass: 'job', id: '42' }),
        observation({ asset: ALPHA, entityClass: 'pipeline', id: 'p1' }),
        observation({ asset: ALPHA, entityClass: 'notebook', id: '99' }),
      ],
      fetchImplementation
    );
    const usage = await studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN });
    expect(usage.assets[0]).toMatchObject({ count: 2, complete: false });
    expect(usage.assets[0]?.objects.map((item) => item.title).sort()).toEqual(['Daily risk job', 'Risk pipeline']);
    expect(paths).toContain('/api/2.1/jobs/get?job_id=42');
    expect(paths).toContain('/api/2.0/pipelines/p1');
  });

  it('uses fallback labels when job and pipeline title lookups return different IDs', async () => {
    const fetchImplementation: typeof fetch = (input) => {
      const path = fetchUrl(input).pathname;
      if (path.endsWith('/Me')) return Promise.resolve(jsonResponse(200, { userName: 'viewer@example.com' }));
      if (path === '/api/2.0/permissions/jobs/42' || path === '/api/2.0/permissions/pipelines/p1') {
        const isJob = path.endsWith('/jobs/42');
        return Promise.resolve(
          jsonResponse(200, {
            object_id: isJob ? '/jobs/42' : '/pipelines/p1',
            object_type: isJob ? 'job' : 'pipelines',
            access_control_list: [
              { user_name: 'viewer@example.com', all_permissions: [{ permission_level: 'CAN_VIEW' }] },
            ],
          })
        );
      }
      if (path === '/api/2.1/jobs/get') {
        return Promise.resolve(jsonResponse(200, { job_id: 420, settings: { name: 'Another job' } }));
      }
      if (path === '/api/2.0/pipelines/p1') {
        return Promise.resolve(jsonResponse(200, { pipeline_id: 'p2', spec: { name: 'Another pipeline' } }));
      }
      return Promise.resolve(jsonResponse(404, { error_code: 'RESOURCE_DOES_NOT_EXIST' }));
    };
    const { studio } = service(
      [
        observation({ asset: ALPHA, entityClass: 'job', id: '42' }),
        observation({ asset: ALPHA, entityClass: 'pipeline', id: 'p1' }),
      ],
      fetchImplementation
    );
    const usage = await studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN });

    expect(usage.assets[0]).toMatchObject({ count: 2, complete: true });
    expect(usage.assets[0]?.objects.map((item) => item.title).sort()).toEqual(['Job 42', 'Pipeline p1']);
    expect(usage.assets[0]?.objects.map((item) => item.url).sort()).toEqual([
      'https://workspace.example.com/jobs/42',
      'https://workspace.example.com/pipelines/p1',
    ]);
  });

  it('accepts a Lakeview ACL resolved from its UUID to a numeric workspace object', async () => {
    const fetchImplementation: typeof fetch = (input) => {
      const path = fetchUrl(input).pathname;
      if (path === '/api/2.0/lakeview/dashboards/d1') {
        return Promise.resolve(jsonResponse(403, { error_code: 'INSUFFICIENT_PRIVILEGES', message: 'Missing scope' }));
      }
      if (path.endsWith('/Me')) return Promise.resolve(jsonResponse(200, { userName: 'viewer@example.com' }));
      if (path === '/api/2.0/permissions/dashboards/d1') {
        return Promise.resolve(
          jsonResponse(200, {
            object_id: '/dashboards/98469842751293',
            object_type: 'dashboard',
            access_control_list: [
              { user_name: 'viewer@example.com', all_permissions: [{ permission_level: 'CAN_MANAGE' }] },
            ],
          })
        );
      }
      return Promise.resolve(jsonResponse(404, { error_code: 'RESOURCE_DOES_NOT_EXIST' }));
    };
    const { studio } = service(
      [observation({ asset: ALPHA, entityClass: 'dashboard_v3', id: 'd1' })],
      fetchImplementation
    );
    const usage = await studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN });

    expect(usage.assets[0]).toMatchObject({ count: 1, complete: true, byType: { dashboard: 1 } });
    expect(usage.assets[0]?.objects[0]).toMatchObject({
      title: 'Dashboard d1',
      url: 'https://workspace.example.com/dashboardsv3/d1/published?w=123456789',
    });
  });

  it('rejects a permissions response for a different resource path', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchImplementation: typeof fetch = (input) => {
      const path = fetchUrl(input).pathname;
      if (path.endsWith('/Me')) return Promise.resolve(jsonResponse(200, { userName: 'viewer@example.com' }));
      if (path === '/api/2.0/permissions/jobs/42') {
        return Promise.resolve(
          jsonResponse(200, {
            object_id: '/jobs/420',
            object_type: 'job',
            access_control_list: [
              { user_name: 'viewer@example.com', all_permissions: [{ permission_level: 'IS_OWNER' }] },
            ],
          })
        );
      }
      if (path === '/api/2.0/permissions/pipelines/p1') {
        return Promise.resolve(
          jsonResponse(200, {
            object_id: '/pipelines/p1/extra',
            object_type: 'pipelines',
            access_control_list: [
              { user_name: 'viewer@example.com', all_permissions: [{ permission_level: 'IS_OWNER' }] },
            ],
          })
        );
      }
      return Promise.resolve(jsonResponse(404, { error_code: 'RESOURCE_DOES_NOT_EXIST' }));
    };
    const { studio } = service(
      [
        observation({ asset: ALPHA, entityClass: 'job', id: '42' }),
        observation({ asset: ALPHA, entityClass: 'pipeline', id: 'p1' }),
      ],
      fetchImplementation
    );
    const usage = await studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN });

    expect(usage.assets[0]).toMatchObject({ count: 0, complete: false, objects: [] });
  });

  it('logs only an allowlisted missing scope, never a permission error body', async () => {
    const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchImplementation: typeof fetch = (input, init) => {
      expect(init?.method).toBe('GET');
      const path = fetchUrl(input).pathname;
      if (path.endsWith('/Me')) return Promise.resolve(jsonResponse(200, { userName: 'viewer@example.com' }));
      return Promise.resolve(
        jsonResponse(403, {
          error_code: 'INSUFFICIENT_PRIVILEGES',
          message: 'Missing scope: access-management for private-job-name and secret-token',
        })
      );
    };
    const { studio } = service([observation({ asset: ALPHA, entityClass: 'job', id: '42' })], fetchImplementation);
    const usage = await studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN });

    expect(usage.assets[0]).toMatchObject({ count: 0, complete: false, objects: [] });
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      '[lineage-impact-studio] Consumer visibility diagnostic',
      '{"kind":"jobs","outcome":"unresolved","checks":[{"status":403,"reason":"scope_denied","scopeHint":"access-management"}]}'
    );
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(
      /private-job-name|secret-token|viewer@example\.com|\/jobs\/42/u
    );
  });

  it('does not count jobs or pipelines from group or another user grants', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchImplementation = vi.fn<typeof fetch>((input) => {
      const path = fetchUrl(input).pathname;
      if (path.endsWith('/Me')) return Promise.resolve(jsonResponse(200, { userName: 'viewer@example.com' }));
      if (path === '/api/2.0/permissions/jobs/42') {
        return Promise.resolve(
          jsonResponse(200, {
            object_id: '/jobs/42',
            object_type: 'job',
            access_control_list: [{ group_name: 'viewers', all_permissions: [{ permission_level: 'CAN_VIEW' }] }],
          })
        );
      }
      if (path === '/api/2.0/permissions/pipelines/p1') {
        return Promise.resolve(
          jsonResponse(200, {
            object_id: '/pipelines/p1',
            object_type: 'pipelines',
            access_control_list: [
              { user_name: 'another@example.com', all_permissions: [{ permission_level: 'CAN_MANAGE' }] },
            ],
          })
        );
      }
      return Promise.resolve(jsonResponse(404, { error_code: 'RESOURCE_DOES_NOT_EXIST' }));
    });
    const { studio } = service(
      [
        observation({ asset: ALPHA, entityClass: 'job', id: '42' }),
        observation({ asset: ALPHA, entityClass: 'pipeline', id: 'p1' }),
      ],
      fetchImplementation
    );
    const usage = await studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN });

    expect(usage.assets[0]).toMatchObject({ count: 0, complete: false, objects: [] });
    expect(fetchImplementation.mock.calls.map(([input]) => fetchUrl(input).pathname)).not.toContain(
      '/api/2.0/pipelines/p1'
    );
    expect(fetchImplementation.mock.calls.map(([input]) => fetchUrl(input).pathname)).not.toContain(
      '/api/2.1/jobs/get'
    );
  });

  it('uses an exact viewer Genie ACL when the OBO Genie GET cannot complete', async () => {
    const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchImplementation: typeof fetch = (input) => {
      const path = fetchUrl(input).pathname;
      if (path === '/api/2.0/genie/spaces/g1') {
        return Promise.resolve(
          jsonResponse(403, { error_code: 'INSUFFICIENT_PRIVILEGES', message: 'Missing API scope' })
        );
      }
      if (path.endsWith('/Me')) return Promise.resolve(jsonResponse(200, { userName: 'viewer@example.com' }));
      if (path === '/api/2.0/permissions/genie/g1') {
        return Promise.resolve(
          jsonResponse(200, {
            object_id: 'g1',
            object_type: 'genie',
            access_control_list: [
              { user_name: 'viewer@example.com', all_permissions: [{ permission_level: 'CAN_VIEW' }] },
            ],
          })
        );
      }
      return Promise.resolve(jsonResponse(404, { error_code: 'RESOURCE_DOES_NOT_EXIST' }));
    };
    const { studio } = service([observation({ asset: ALPHA, entityClass: 'genie', id: 'g1' })], fetchImplementation);
    const usage = await studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN });
    expect(usage.assets[0]).toMatchObject({ count: 1, complete: true, byType: { genie: 1 } });
    expect(usage.assets[0]?.objects[0]).toMatchObject({
      title: 'Genie room g1',
      url: 'https://workspace.example.com/genie/rooms/g1',
    });
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it('logs only fixed status and reason labels when Genie OBO scopes are unresolved', async () => {
    const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchImplementation: typeof fetch = (input) => {
      const path = fetchUrl(input).pathname;
      if (path === '/api/2.0/genie/spaces/g1') {
        return Promise.resolve(
          jsonResponse(403, {
            error_code: 'INSUFFICIENT_PRIVILEGES',
            message: 'Missing scope for private-space-name and secret-token',
          })
        );
      }
      if (path.endsWith('/Me')) return Promise.resolve(jsonResponse(200, { userName: 'viewer@example.com' }));
      return Promise.resolve(
        jsonResponse(403, { error_code: 'PERMISSION_DENIED', message: 'Private ACL detail: secret-token' })
      );
    };
    const { studio } = service([observation({ asset: ALPHA, entityClass: 'genie', id: 'g1' })], fetchImplementation);
    const usage = await studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN });

    expect(usage.assets[0]).toMatchObject({ count: 0, complete: false, objects: [] });
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      '[lineage-impact-studio] Genie visibility diagnostic',
      '{"outcome":"unresolved","checks":[{"probe":"get","status":403,"reason":"scope_denied"},{"probe":"acl","status":403,"reason":"access_denied"}]}'
    );
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(
      /g1|private-space-name|secret-token|viewer@example\.com|viewer-obo-token/u
    );
  });

  it('reports malformed and mismatched Genie responses without logging response content', async () => {
    const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchImplementation: typeof fetch = (input) => {
      const path = fetchUrl(input).pathname;
      if (path === '/api/2.0/genie/spaces/g1') return Promise.resolve(new Response('private invalid JSON'));
      if (path.endsWith('/Me')) return Promise.resolve(jsonResponse(200, { userName: 'viewer@example.com' }));
      return Promise.resolve(
        jsonResponse(200, {
          object_id: 'another-secret-space',
          object_type: 'genie',
          access_control_list: [
            { user_name: 'viewer@example.com', all_permissions: [{ permission_level: 'CAN_VIEW' }] },
          ],
        })
      );
    };
    const { studio } = service([observation({ asset: ALPHA, entityClass: 'genie', id: 'g1' })], fetchImplementation);
    const usage = await studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN });

    expect(usage.assets[0]).toMatchObject({ count: 0, complete: false, objects: [] });
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      '[lineage-impact-studio] Genie visibility diagnostic',
      '{"outcome":"unresolved","checks":[{"probe":"get","status":200,"reason":"invalid_json"},{"probe":"acl","status":200,"reason":"id_mismatch"}]}'
    );
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(
      /g1|private invalid JSON|another-secret-space|viewer@example\.com|viewer-obo-token/u
    );
  });

  it('does not trust a Genie ACL response for another object', async () => {
    const fetchImplementation: typeof fetch = (input) => {
      const path = fetchUrl(input).pathname;
      if (path === '/api/2.0/genie/spaces/g1') {
        return Promise.resolve(jsonResponse(403, { error_code: 'PERMISSION_DENIED' }));
      }
      if (path.endsWith('/Me')) return Promise.resolve(jsonResponse(200, { userName: 'viewer@example.com' }));
      return Promise.resolve(
        jsonResponse(200, {
          object_id: 'another-space',
          object_type: 'genie',
          access_control_list: [
            { user_name: 'viewer@example.com', all_permissions: [{ permission_level: 'CAN_VIEW' }] },
          ],
        })
      );
    };
    const { studio } = service([observation({ asset: ALPHA, entityClass: 'genie', id: 'g1' })], fetchImplementation);
    const usage = await studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN });
    expect(usage.assets[0]).toMatchObject({ count: 0, complete: false, objects: [] });
  });

  it('fails the endpoint safely when the lineage query is unavailable', async () => {
    const executor: LineageQueryExecutor = { query: vi.fn().mockRejectedValue(new Error('secret SQL details')) };
    const studio = new UsageService({
      executor,
      workspaceHost: 'https://workspace.example.com',
      workspaceId: '123456789',
      now: () => NOW,
    });
    await expect(studio.getUsage({ view: assessment([[ROOT, ALPHA]]), oboToken: TOKEN })).rejects.toBeInstanceOf(
      UsageUnavailableError
    );
  });

  it('does not treat dashboard refresh jobs as separate persistent consumers', () => {
    const statement = buildLineageSql(1);
    expect(statement).toMatch(
      /named_struct\('entity_class', 'job', 'entity_id',\s*CASE WHEN entity_metadata\.dashboard_id IS NOT NULL/u
    );
    expect(statement).toContain('OR entity_metadata.legacy_dashboard_id IS NOT NULL');
    expect(statement).toContain("OR entity_type IN ('DASHBOARD_V3', 'DBSQL_DASHBOARD')");
  });
});
