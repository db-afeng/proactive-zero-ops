import { describe, expect, it } from 'vitest';

import { createAssessmentViewV1, redactLineagePath, serializeAssessmentViewV1 } from './assessment-view';

const REFERENCE = 'lgr_0123456789abcdefghijklmnopqrstuv';

function baseInput() {
  return {
    reference: REFERENCE,
    status: 'block' as const,
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

describe('contiguous lineage redaction', () => {
  it('collapses every contiguous hidden run without emitting hidden names, types, or counts', () => {
    const segments = redactLineagePath([
      { authorized: false, asset: { reference: 'hidden.one', assetType: 'view' } },
      { authorized: false, asset: { reference: 'hidden.two', assetType: 'table' } },
      {
        authorized: true,
        asset: { reference: 'catalog.schema.visible', assetType: 'table' },
      },
      { authorized: false, asset: { reference: 'hidden.three', assetType: 'streaming_table' } },
    ]);

    expect(segments).toEqual([
      { kind: 'restricted' },
      { kind: 'asset', reference: 'catalog.schema.visible', assetType: 'table' },
      { kind: 'restricted' },
    ]);
    const serialized = JSON.stringify(segments);
    expect(serialized).not.toContain('hidden.one');
    expect(serialized).not.toContain('hidden.two');
    expect(serialized).not.toContain('hidden.three');
    expect(serialized).not.toContain('count');
  });

  it('derives partial disclosure and only uses fixed operational copy', () => {
    const view = createAssessmentViewV1({
      ...baseInput(),
      lineagePaths: [
        {
          segments: [
            { kind: 'asset', reference: 'catalog.schema.visible', assetType: 'table' },
            { kind: 'restricted' },
          ],
        },
      ],
    });
    expect(view.disclosure.state).toBe('partial');
    expect(view.message).toBe('A potentially breaking downstream impact was identified.');
  });
});

describe('AssessmentViewV1 leakage boundary', () => {
  it('rejects raw evidence or arbitrary metadata at the final serialization boundary', () => {
    const view = createAssessmentViewV1({
      ...baseInput(),
      lineagePaths: [
        {
          segments: [{ kind: 'asset', reference: 'catalog.schema.visible', assetType: 'table' }],
        },
      ],
    });
    const withEvidence = { ...view, evidence: { sql: 'SELECT * FROM secret.table' } };
    expect(() => serializeAssessmentViewV1(withEvidence)).toThrow();

    const withAssetOwner = {
      ...view,
      lineagePaths: [
        {
          segments: [
            {
              kind: 'asset',
              reference: 'catalog.schema.visible',
              assetType: 'table',
              owner: 'private-owner',
            },
          ],
        },
      ],
    };
    expect(() => serializeAssessmentViewV1(withAssetOwner)).toThrow();
  });

  it('serializes exactly the validated allowlist', () => {
    const view = createAssessmentViewV1({ ...baseInput(), lineagePaths: [] });
    expect(JSON.parse(serializeAssessmentViewV1(view))).toEqual(view);
    expect(view.disclosure.state).toBe('full');
  });
});
