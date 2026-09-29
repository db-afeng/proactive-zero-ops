import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import {
  AssessmentPermissionCheckError,
  AssessmentService,
  AssessmentUnavailableError,
  DetailedEvidenceUnavailableError,
  createAuthorizedFixContext,
} from './assessment-service';

const reference = 'lgr_0123456789abcdefghijklmnopqrstuv';
const now = new Date('2026-09-28T12:00:00Z');

function request(): Request {
  const result = Object.create(null) as Request;
  result.headers = {
    'x-forwarded-user': 'viewer-id',
    'x-forwarded-email': 'viewer@example.com',
    'x-forwarded-access-token': 't'.repeat(32),
  };
  return result;
}

function payload(createdAt = '2026-09-28T10:00:00Z', version: 2 | 3 = 3): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      schema_version: version,
      assessment_reference: reference,
      created_at: createdAt,
      source: {
        provider: 'github',
        repository: 'db-afeng/proactive-zero-ops',
        pull_request_number: 4,
        base_sha: 'a'.repeat(40),
        head_sha: 'b'.repeat(40),
      },
      classification: 'restricted',
      authentication: 'required',
      viewer_authorization: 'required',
      assessment_principal: 'service_principal',
      evidence:
        version === 2
          ? { result: { status: 'block', summary: 'legacy raw model prose' } }
          : {
              result: {
                status: 'block',
                severity: 'high',
                confidence: 0.95,
                assessment_complete: true,
                discovery_certainty: 'complete',
                summary: 'raw model prose',
              },
              display_evidence: {
                schema_version: 1,
                headline: 'balance is now text, but exposure still performs arithmetic.',
                recommended_action: 'Keep the source column numeric.',
                changes: [
                  {
                    id: 'change-1',
                    asset: 'catalog.schema.allowed',
                    column: 'balance',
                    change_kind: 'modified',
                    before_type: 'numeric',
                    after_type: 'text',
                    before_expression: 'secret before SQL',
                    after_expression: 'secret after SQL',
                    file_path: 'src/source.sql',
                  },
                ],
                impacts: [
                  {
                    id: 'impact-1',
                    change_id: 'change-1',
                    relation: 'transitive',
                    target_asset: 'catalog.schema.allowed_two',
                    target_column: 'exposure',
                    operation: 'arithmetic',
                    reason: 'incompatible_type',
                    evidence_level: 'definition',
                    path: [
                      'catalog.schema.allowed',
                      'catalog.schema.hidden_one',
                      'catalog.schema.hidden_two',
                      'catalog.schema.allowed_two',
                    ],
                    target_expression: 'secret target SQL',
                    remediation: 'restore_contract',
                  },
                ],
                edges: [
                  edge('edge-1', 'catalog.schema.allowed', 'catalog.schema.hidden_one'),
                  edge('edge-2', 'catalog.schema.hidden_one', 'catalog.schema.hidden_two'),
                  edge('edge-3', 'catalog.schema.hidden_two', 'catalog.schema.allowed_two'),
                ],
              },
              identity_semantics: { assessment_principal: 'service_principal', on_behalf_of_user: false },
            },
    })
  );
}

function edge(id: string, source: string, target: string) {
  return {
    id,
    source_asset: source,
    target_asset: target,
    source_column: null,
    target_column: null,
    level: 'table',
    origins: ['observed_lineage'],
    last_observed_at: null,
  };
}

function service(bytes = payload()) {
  return new AssessmentService({
    reader: { read: vi.fn().mockResolvedValue(bytes) },
    assetAccessQuery: 'SELECT access',
    now: () => now,
  });
}

function authorizationRows(authorized = true) {
  return {
    data: [
      { ordinal: 0, asset_reference: 'catalog.schema.allowed', can_select: authorized, asset_type: 'TABLE' },
      { ordinal: 1, asset_reference: 'catalog.schema.allowed_two', can_select: authorized, asset_type: 'VIEW' },
      { ordinal: 2, asset_reference: 'catalog.schema.hidden_one', can_select: false, asset_type: 'TABLE' },
      { ordinal: 3, asset_reference: 'catalog.schema.hidden_two', can_select: false, asset_type: 'VIEW' },
    ],
  };
}

describe('AssessmentService', () => {
  it('returns structured facts with one anonymous restricted lineage placeholder', async () => {
    const studio = service();
    const view = await studio.getView({
      request: request(),
      reference,
      userAnalytics: { query: vi.fn().mockResolvedValue(authorizationRows()) },
    });

    expect(view.detailState).toBe('available');
    expect(view.impacts[0]?.path).toEqual([
      { kind: 'asset', reference: 'catalog.schema.allowed', assetType: 'table' },
      { kind: 'restricted' },
      { kind: 'asset', reference: 'catalog.schema.allowed_two', assetType: 'view' },
    ]);
    expect(view.graph.nodes.filter((node) => node.role === 'restricted')).toHaveLength(1);
    expect(view.disclosure.state).toBe('partial');
    expect(JSON.stringify(view)).not.toContain('hidden_one');
    expect(JSON.stringify(view)).not.toContain('secret target SQL');
    expect(createAuthorizedFixContext(view).authorizedLineage).toEqual([
      [
        { reference: 'catalog.schema.allowed', assetType: 'table' },
        { reference: 'catalog.schema.allowed_two', assetType: 'view' },
      ],
    ]);

    const source = await studio.getSourceEvidence({ reference, authorizedView: view });
    expect(source.changes[0]?.beforeExpression).toBe('secret before SQL');
    expect(source.impacts[0]?.targetExpression).toBe('secret target SQL');
  });

  it('returns a rerun-required view for legacy v2 and refuses source reconstruction', async () => {
    const studio = service(payload('2026-09-28T10:00:00Z', 2));
    const view = await studio.getView({
      request: request(),
      reference,
      userAnalytics: { query: vi.fn() },
    });
    expect(view.detailState).toBe('legacy');
    expect(view.graph.nodes).toEqual([]);
    await expect(studio.getSourceEvidence({ reference, authorizedView: view })).rejects.toBeInstanceOf(
      DetailedEvidenceUnavailableError
    );
  });

  it('uses the same generic unavailable response for missing, expired, and no-access references', async () => {
    const missing = new AssessmentService({
      reader: { read: vi.fn().mockRejectedValue(new Error('missing')) },
      assetAccessQuery: 'SELECT access',
    });
    await expect(
      missing.getView({ request: request(), reference, userAnalytics: { query: vi.fn() } })
    ).rejects.toBeInstanceOf(AssessmentUnavailableError);

    await expect(
      service(payload('2026-08-01T10:00:00Z')).getView({
        request: request(),
        reference,
        userAnalytics: { query: vi.fn() },
      })
    ).rejects.toBeInstanceOf(AssessmentUnavailableError);

    await expect(
      service().getView({
        request: request(),
        reference,
        userAnalytics: { query: vi.fn().mockResolvedValue(authorizationRows(false)) },
      })
    ).rejects.toBeInstanceOf(AssessmentUnavailableError);
  });

  it('does not fall back when OBO verification fails', async () => {
    await expect(
      service().getView({
        request: request(),
        reference,
        userAnalytics: { query: vi.fn().mockRejectedValue(new Error('OBO denied')) },
      })
    ).rejects.toBeInstanceOf(AssessmentPermissionCheckError);
  });
});
