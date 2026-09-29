import { describe, expect, it } from 'vitest';

import { InvalidRestrictedEnvelopeError, parseRestrictedAssessmentEnvelope } from './restricted-envelope';

const REFERENCE = 'lgr_0123456789abcdefghijklmnopqrstuv';

function v3Envelope() {
  return {
    schema_version: 3,
    assessment_reference: REFERENCE,
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
    evidence: {
      result: {
        status: 'block',
        severity: 'high',
        confidence: 0.95,
        summary: 'raw model prose remains server-side',
        assessment_complete: true,
        discovery_certainty: 'complete',
      },
      display_evidence: {
        schema_version: 1,
        headline: 'A numeric contract changed to text.',
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
            source_asset: 'catalog.schema.source',
            target_asset: 'catalog.schema.consumer',
            source_column: 'balance',
            target_column: 'exposure',
            level: 'column',
            origins: ['observed_lineage'],
            last_observed_at: '2026-09-28T09:00:00Z',
          },
        ],
      },
      identity_semantics: { assessment_principal: 'service_principal', on_behalf_of_user: false },
    },
  };
}

describe('restricted assessment envelopes', () => {
  it('parses the strict v3 evidence schema and binds it to the file reference', () => {
    const parsed = parseRestrictedAssessmentEnvelope(JSON.stringify(v3Envelope()), REFERENCE);
    expect(parsed.schema_version).toBe(3);
    expect(parsed.source.pull_request_number).toBe(4);
  });

  it('accepts v2 only as a legacy opaque envelope', () => {
    const legacy = { ...v3Envelope(), schema_version: 2, evidence: { result: { status: 'block' } } };
    expect(parseRestrictedAssessmentEnvelope(legacy, REFERENCE).schema_version).toBe(2);
  });

  it.each([
    ['broadened classification', { classification: 'public' }],
    ['service-principal fallback policy', { viewer_authorization: 'optional' }],
    ['unknown outer field', { secret: 'must-not-be-tolerated' }],
  ])('rejects %s without reflecting evidence', (_label, change) => {
    const candidate = { ...v3Envelope(), ...change };
    expect(() => parseRestrictedAssessmentEnvelope(candidate, REFERENCE)).toThrow(InvalidRestrictedEnvelopeError);
    try {
      parseRestrictedAssessmentEnvelope(candidate, REFERENCE);
    } catch (error) {
      expect((error as Error).message).not.toContain('must-not-be-tolerated');
      expect((error as Error).message).not.toContain('catalog.schema.consumer');
    }
  });

  it('fails closed for malformed v3 display evidence', () => {
    const candidate = v3Envelope();
    candidate.evidence.display_evidence.impacts[0].change_id = 'unknown-change';
    expect(() => parseRestrictedAssessmentEnvelope(candidate, REFERENCE)).toThrow(InvalidRestrictedEnvelopeError);
  });

  it('rejects unknown v3 result fields rather than widening the evidence contract', () => {
    const candidate = v3Envelope();
    Object.assign(candidate.evidence.result, { browser_hint: 'render raw model prose' });
    expect(() => parseRestrictedAssessmentEnvelope(candidate, REFERENCE)).toThrow(InvalidRestrictedEnvelopeError);
  });

  it('rejects a valid envelope stored under a different reference', () => {
    expect(() => parseRestrictedAssessmentEnvelope(v3Envelope(), 'lgr_vwxyz0123456789abcdefghijklmnop')).toThrow(
      InvalidRestrictedEnvelopeError
    );
  });

  it('rejects invalid UTF-8 and non-finite evidence values', () => {
    expect(() => parseRestrictedAssessmentEnvelope(Uint8Array.from([0xff, 0xfe]), REFERENCE)).toThrow(
      InvalidRestrictedEnvelopeError
    );
    const candidate = v3Envelope();
    candidate.evidence.result.confidence = Number.NaN;
    expect(() => parseRestrictedAssessmentEnvelope(candidate, REFERENCE)).toThrow(InvalidRestrictedEnvelopeError);
  });
});
