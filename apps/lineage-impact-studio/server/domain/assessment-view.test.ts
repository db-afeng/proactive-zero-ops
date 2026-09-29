import { describe, expect, it } from 'vitest';

import { createAssessmentViewV2, serializeAssessmentViewV2 } from './assessment-view';
import type { EvidenceProjection } from './evidence-projection';

const REFERENCE = 'lgr_0123456789abcdefghijklmnopqrstuv';

function baseInput() {
  return {
    reference: REFERENCE,
    source: {
      provider: 'github' as const,
      createdAt: '2026-09-28T10:00:00Z',
      freshness: 'current' as const,
    },
    pullRequest: {
      repository: 'db-afeng/proactive-zero-ops',
      number: 4,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    },
    viewer: { subject: 'viewer-id', displayName: 'Viewer Name' },
  };
}

function projection(): Extract<EvidenceProjection, { detailState: 'available' }> {
  return {
    detailState: 'available',
    status: 'block',
    severity: 'high',
    interpretationConfidence: 0.95,
    discoveryCertainty: 'complete',
    assessmentComplete: true,
    uniqueAssets: [
      { reference: 'catalog.schema.source', assetType: 'unknown' },
      { reference: 'catalog.schema.hidden', assetType: 'unknown' },
      { reference: 'catalog.schema.consumer', assetType: 'unknown' },
    ],
    display: {
      schema_version: 1,
      headline: 'balance is now text, but exposure still performs arithmetic.',
      recommended_action: 'Keep the source column numeric.',
      changes: [
        {
          id: 'change-1',
          asset: 'catalog.schema.source',
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
          target_asset: 'catalog.schema.consumer',
          target_column: 'exposure',
          operation: 'arithmetic',
          reason: 'incompatible_type',
          evidence_level: 'definition',
          path: ['catalog.schema.source', 'catalog.schema.hidden', 'catalog.schema.consumer'],
          target_expression: 'secret target SQL',
          remediation: 'restore_contract',
        },
      ],
      edges: [
        {
          id: 'edge-1',
          source_asset: 'catalog.schema.source',
          target_asset: 'catalog.schema.hidden',
          source_column: null,
          target_column: null,
          level: 'table',
          origins: ['proposed_code'],
          last_observed_at: null,
        },
        {
          id: 'edge-2',
          source_asset: 'catalog.schema.hidden',
          target_asset: 'catalog.schema.consumer',
          source_column: null,
          target_column: null,
          level: 'table',
          origins: ['observed_lineage'],
          last_observed_at: null,
        },
      ],
    },
  };
}

describe('AssessmentViewV2 authorization boundary', () => {
  it('uses one anonymous restricted placeholder and does not serialize raw expressions', () => {
    const view = createAssessmentViewV2({
      ...baseInput(),
      projection: projection(),
      access: new Map([
        ['catalog.schema.source', { authorized: true, assetType: 'table' as const }],
        ['catalog.schema.hidden', { authorized: false, assetType: 'view' as const }],
        ['catalog.schema.consumer', { authorized: true, assetType: 'view' as const }],
      ]),
    });
    expect(view.disclosure.state).toBe('partial');
    expect(view.impacts[0]?.path).toEqual([
      { kind: 'asset', reference: 'catalog.schema.source', assetType: 'table' },
      { kind: 'restricted' },
      { kind: 'asset', reference: 'catalog.schema.consumer', assetType: 'view' },
    ]);
    expect(view.graph.nodes.filter((node) => node.role === 'restricted')).toHaveLength(1);
    const serialized = serializeAssessmentViewV2(view);
    expect(serialized).not.toContain('catalog.schema.hidden');
    expect(serialized).not.toContain('secret before SQL');
    expect(serialized).not.toContain('secret target SQL');
  });

  it('returns a detail-free rerun state for legacy v2 evidence', () => {
    const view = createAssessmentViewV2({
      ...baseInput(),
      projection: { detailState: 'legacy', status: 'block', uniqueAssets: [] },
      access: new Map(),
    });
    expect(view.detailState).toBe('legacy');
    expect(view.graph.nodes).toEqual([]);
    expect(view.recommendedAction).toContain('Re-run');
  });

  it('does not leak a hidden changed column or type through headline copy', () => {
    const projected = projection();
    projected.display.headline = 'secret_balance is now text and breaks a hidden consumer.';
    const view = createAssessmentViewV2({
      ...baseInput(),
      projection: projected,
      access: new Map([
        ['catalog.schema.source', { authorized: false, assetType: 'table' as const }],
        ['catalog.schema.hidden', { authorized: false, assetType: 'view' as const }],
        ['catalog.schema.consumer', { authorized: true, assetType: 'view' as const }],
      ]),
    });
    const serialized = serializeAssessmentViewV2(view);
    expect(serialized).not.toContain('secret_balance');
    expect(serialized).not.toContain('catalog.schema.source');
    expect(serialized).not.toContain('numeric');
    expect(view.graph.nodes).toEqual([{ id: 'restricted', role: 'restricted', label: 'Restricted lineage' }]);
  });

  it('labels an authorized intermediate path node as optional supporting context', () => {
    const view = createAssessmentViewV2({
      ...baseInput(),
      projection: projection(),
      access: new Map([
        ['catalog.schema.source', { authorized: true, assetType: 'table' as const }],
        ['catalog.schema.hidden', { authorized: true, assetType: 'view' as const }],
        ['catalog.schema.consumer', { authorized: true, assetType: 'view' as const }],
      ]),
    });
    expect(view.graph.nodes).toContainEqual({
      id: 'context-1',
      role: 'context',
      label: 'hidden',
      asset: 'catalog.schema.hidden',
      assetType: 'view',
    });
    expect(view.graph.edges.some((edge) => edge.source === 'context-1' && edge.target === 'impact-impact-1')).toBe(
      true
    );
  });

  it('rejects arbitrary metadata at the final serialization boundary', () => {
    const view = createAssessmentViewV2({
      ...baseInput(),
      projection: { detailState: 'legacy', status: 'block', uniqueAssets: [] },
      access: new Map(),
    });
    expect(() => serializeAssessmentViewV2({ ...view, evidence: { sql: 'SELECT secret' } })).toThrow();
  });
});
