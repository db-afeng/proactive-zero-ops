import { describe, expect, it } from 'vitest';

import { projectRestrictedEvidence, splitAssetReference } from './evidence-projection';
import { parseRestrictedAssessmentEnvelope } from './restricted-envelope';

const reference = 'lgr_0123456789abcdefghijklmnopqrstuv';

function envelope(evidence: unknown) {
  return parseRestrictedAssessmentEnvelope({
    schema_version: 2,
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
    evidence,
  });
}

describe('projectRestrictedEvidence', () => {
  it('projects only validated assets and public status', () => {
    const projected = projectRestrictedEvidence(
      envelope({
        result: {
          status: 'block',
          impacts: [
            {
              path: ['catalog.schema.changed', 'catalog.schema.secret', 'catalog.schema.dashboard'],
              failure_mode: 'raw free-form text must not cross the boundary',
            },
          ],
          lineage_edges: [
            {
              source_table: 'catalog.schema.changed',
              target_table: 'catalog.schema.dashboard',
              target_type: 'VIEW',
            },
          ],
          changed_columns: [{ table: 'catalog.schema.changed', evidence: 'secret SQL' }],
        },
        discovery: {
          affected_datasets: ['catalog.schema.changed', '../not-an-asset'],
        },
      })
    );

    expect(projected.status).toBe('block');
    expect(projected.uniqueAssets.map((asset) => asset.reference)).toEqual([
      'catalog.schema.changed',
      'catalog.schema.secret',
      'catalog.schema.dashboard',
    ]);
    expect(JSON.stringify(projected)).not.toContain('failure_mode');
    expect(JSON.stringify(projected)).not.toContain('secret SQL');
    expect(projected.uniqueAssets.find((asset) => asset.reference.endsWith('dashboard'))?.assetType).toBe('view');
  });

  it('supports a pass assessment with no referenced assets', () => {
    expect(projectRestrictedEvidence(envelope({ result: { status: 'pass' } }))).toEqual({
      status: 'pass',
      lineagePaths: [],
      uniqueAssets: [],
    });
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
