import { describe, expect, it } from 'vitest';

import { EvidenceProjectionError, projectRestrictedEvidence, splitAssetReference } from './evidence-projection';
import { parseRestrictedAssessmentEnvelope } from './restricted-envelope';

const reference = 'lgr_0123456789abcdefghijklmnopqrstuv';

function envelope(options?: { unrelatedEdge?: boolean; legacy?: boolean }) {
  const display = {
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
        before_expression: 'CAST(raw AS DECIMAL(18, 2))',
        after_expression: "CONCAT('AUD ', raw)",
        file_path: 'src/source.sql',
      },
    ],
    impacts: [
      {
        id: 'impact-1',
        change_id: 'change-1',
        relation: 'direct',
        target_asset: 'catalog.schema.consumer',
        target_column: 'exposure',
        operation: 'arithmetic',
        reason: 'incompatible_type',
        evidence_level: 'definition',
        path: ['catalog.schema.source', 'catalog.schema.consumer'],
        target_expression: 'balance + fees',
        remediation: 'restore_contract',
      },
    ],
    edges: [
      {
        id: 'edge-1',
        source_asset: options?.unrelatedEdge ? 'catalog.schema.unrelated' : 'catalog.schema.source',
        target_asset: 'catalog.schema.consumer',
        source_column: 'balance',
        target_column: 'exposure',
        level: 'column',
        origins: ['observed_lineage'],
        last_observed_at: null,
      },
    ],
  };
  return parseRestrictedAssessmentEnvelope({
    schema_version: options?.legacy ? 2 : 3,
    assessment_reference: reference,
    created_at: '2026-09-28T10:00:00Z',
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
    evidence: options?.legacy
      ? { result: { status: 'block', summary: 'do not reconstruct this' } }
      : {
          result: {
            status: 'block',
            severity: 'high',
            confidence: 0.95,
            summary: 'raw model prose remains server-side',
            assessment_complete: true,
            discovery_certainty: 'complete',
          },
          display_evidence: display,
          identity_semantics: { assessment_principal: 'service_principal', on_behalf_of_user: false },
        },
  });
}

describe('projectRestrictedEvidence', () => {
  it('projects only deterministic v3 display evidence and causal assets', () => {
    const projected = projectRestrictedEvidence(envelope());
    expect(projected.detailState).toBe('available');
    expect(projected.uniqueAssets.map((asset) => asset.reference)).toEqual([
      'catalog.schema.consumer',
      'catalog.schema.source',
    ]);
    expect(JSON.stringify(projected)).not.toContain('summary');
  });

  it('does not reconstruct legacy evidence', () => {
    expect(projectRestrictedEvidence(envelope({ legacy: true }))).toEqual({
      detailState: 'legacy',
      status: 'block',
      uniqueAssets: [],
    });
  });

  it('rejects an edge that is not part of a verified impact path', () => {
    expect(() => projectRestrictedEvidence(envelope({ unrelatedEdge: true }))).toThrow(EvidenceProjectionError);
  });
});

describe('splitAssetReference', () => {
  it('returns parameter values without constructing SQL identifiers', () => {
    expect(splitAssetReference('catalog_name.schema-name.table_name')).toEqual({
      catalogName: 'catalog_name',
      schemaName: 'schema-name',
      assetName: 'table_name',
    });
  });

  it('rejects partial and path-like references', () => {
    expect(() => splitAssetReference('catalog.schema')).toThrow();
    expect(() => splitAssetReference('catalog.schema../table')).toThrow();
  });
});
