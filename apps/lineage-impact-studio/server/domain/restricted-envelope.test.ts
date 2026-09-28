import { describe, expect, it } from 'vitest';

import { InvalidRestrictedEnvelopeError, parseRestrictedAssessmentEnvelope } from './restricted-envelope';

const REFERENCE = 'lgr_0123456789abcdefghijklmnopqrstuv';

function envelope() {
  return {
    schema_version: 2,
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
        impacts: [{ path: ['catalog.schema.source', 'catalog.schema.consumer'] }],
      },
    },
  };
}

describe('restricted assessment envelope v2', () => {
  it('parses the exact Python publisher wire schema and binds it to the file reference', () => {
    const parsed = parseRestrictedAssessmentEnvelope(JSON.stringify(envelope()), REFERENCE);
    expect(parsed.schema_version).toBe(2);
    expect(parsed.source.pull_request_number).toBe(4);
  });

  it.each([
    ['wrong schema version', { schema_version: 1 }],
    ['broadened classification', { classification: 'public' }],
    ['service-principal fallback policy', { viewer_authorization: 'optional' }],
    ['unknown outer field', { secret: 'must-not-be-tolerated' }],
  ])('rejects %s without reflecting evidence', (_label, change) => {
    const candidate = { ...envelope(), ...change };
    expect(() => parseRestrictedAssessmentEnvelope(candidate, REFERENCE)).toThrow(InvalidRestrictedEnvelopeError);
    try {
      parseRestrictedAssessmentEnvelope(candidate, REFERENCE);
    } catch (error) {
      expect((error as Error).message).not.toContain('must-not-be-tolerated');
      expect((error as Error).message).not.toContain('catalog.schema.consumer');
    }
  });

  it('rejects a valid envelope stored under a different reference', () => {
    expect(() => parseRestrictedAssessmentEnvelope(envelope(), 'lgr_vwxyz0123456789abcdefghijklmnop')).toThrow(
      InvalidRestrictedEnvelopeError
    );
  });

  it('rejects invalid UTF-8 and non-finite evidence values', () => {
    expect(() => parseRestrictedAssessmentEnvelope(Uint8Array.from([0xff, 0xfe]), REFERENCE)).toThrow(
      InvalidRestrictedEnvelopeError
    );
    expect(() => parseRestrictedAssessmentEnvelope({ ...envelope(), evidence: Number.NaN }, REFERENCE)).toThrow(
      InvalidRestrictedEnvelopeError
    );
  });
});
