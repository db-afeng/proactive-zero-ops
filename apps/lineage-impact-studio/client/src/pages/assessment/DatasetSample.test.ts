import { describe, expect, it } from 'vitest';

import { findHighlightedColumn, parseSampleRows, sampleErrorKind } from './dataset-sample-model';

describe('dataset samples', () => {
  it('parses authorized JSON rows and preserves the union of columns', () => {
    expect(
      parseSampleRows([
        { row_json: JSON.stringify({ id: 1, changed_value: 'a' }) },
        { row_json: JSON.stringify({ id: 2, downstream_value: 'b' }) },
      ])
    ).toEqual({
      kind: 'ready',
      rows: [
        { id: 1, changed_value: 'a' },
        { id: 2, downstream_value: 'b' },
      ],
      columns: ['id', 'changed_value', 'downstream_value'],
    });
  });

  it('accepts JSON objects decoded by AppKit Arrow fallback delivery', () => {
    expect(parseSampleRows([{ row_json: { id: 1, changed_value: 'a' } }])).toEqual({
      kind: 'ready',
      rows: [{ id: 1, changed_value: 'a' }],
      columns: ['id', 'changed_value'],
    });
  });

  it('handles empty, malformed, and oversized results safely', () => {
    expect(parseSampleRows([])).toEqual({ kind: 'ready', rows: [], columns: [] });
    expect(parseSampleRows([{ row_json: '{broken' }])).toEqual({ kind: 'malformed' });
    expect(parseSampleRows([{ row_json: JSON.stringify(['not', 'a', 'row']) }])).toEqual({ kind: 'malformed' });
    expect(parseSampleRows([{ row_json: JSON.stringify({ value: 'x'.repeat(750_001) }) }])).toEqual({
      kind: 'oversized',
    });
  });

  it('detects highlighted and missing columns case-insensitively', () => {
    expect(findHighlightedColumn(['ACCOUNT_ID', 'Balance'], 'balance')).toBe('Balance');
    expect(findHighlightedColumn(['ACCOUNT_ID'], 'balance')).toBeNull();
  });

  it('classifies permission revocation, oversized payloads, and generic failures', () => {
    expect(sampleErrorKind('INSUFFICIENT_PRIVILEGES')).toBe('permission');
    expect(sampleErrorKind('Event exceeds max size')).toBe('oversized');
    expect(sampleErrorKind('warehouse unavailable')).toBe('generic');
  });
});
