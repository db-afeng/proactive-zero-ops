import { describe, expect, it } from 'vitest';

import { findHighlightedColumn, parseSampleRows, parseStructType, sampleErrorKind } from './dataset-sample-model';

describe('dataset samples', () => {
  it('parses authorized JSON rows and preserves the union of columns', () => {
    expect(
      parseSampleRows([
        {
          row_json: JSON.stringify({ id: 1, changed_value: 'a', downstream_value: null }),
          row_type: 'struct<id:bigint,changed_value:string,downstream_value:string>',
        },
        {
          row_json: JSON.stringify({ id: 2, downstream_value: 'b' }),
          row_type: 'struct<id:bigint,changed_value:string,downstream_value:string>',
        },
      ])
    ).toEqual({
      kind: 'ready',
      rows: [
        { id: 1, changed_value: 'a', downstream_value: null },
        { id: 2, downstream_value: 'b' },
      ],
      columns: ['id', 'changed_value', 'downstream_value'],
      columnTypes: { id: 'bigint', changed_value: 'string', downstream_value: 'string' },
    });
  });

  it('accepts JSON objects decoded by AppKit Arrow fallback delivery', () => {
    expect(
      parseSampleRows([{ row_json: { id: 1, changed_value: 'a' }, row_type: 'struct<id:int,changed_value:string>' }])
    ).toEqual({
      kind: 'ready',
      rows: [{ id: 1, changed_value: 'a' }],
      columns: ['id', 'changed_value'],
      columnTypes: { id: 'int', changed_value: 'string' },
    });
  });

  it('parses exact nested SQL types and quoted column names', () => {
    expect(
      parseStructType(
        'struct<account_id:string,amount:decimal(18,2),details:struct<code:string,values:array<int>>,`odd:name`:map<string,decimal(9,3)>,`tick``name`:boolean>'
      )
    ).toEqual({
      account_id: 'string',
      amount: 'decimal(18,2)',
      details: 'struct<code:string,values:array<int>>',
      'odd:name': 'map<string,decimal(9,3)>',
      'tick`name': 'boolean',
    });
  });

  it('handles empty, malformed, and oversized results safely', () => {
    expect(parseSampleRows([])).toEqual({ kind: 'ready', rows: [], columns: [], columnTypes: {} });
    expect(parseSampleRows([{ row_json: '{broken', row_type: 'struct<id:int>' }])).toEqual({ kind: 'malformed' });
    expect(parseSampleRows([{ row_json: JSON.stringify(['not', 'a', 'row']), row_type: 'struct<id:int>' }])).toEqual({
      kind: 'malformed',
    });
    expect(
      parseSampleRows([{ row_json: JSON.stringify({ value: 'x'.repeat(750_001) }), row_type: 'struct<value:string>' }])
    ).toEqual({ kind: 'oversized' });
    expect(parseSampleRows([{ row_json: { id: 1 }, row_type: 'not-a-struct' }])).toEqual({ kind: 'malformed' });
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
