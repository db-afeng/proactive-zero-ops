const MAX_SAMPLE_BYTES = 750_000;

export type SampleRow = Record<string, unknown>;

export type ParsedSample =
  | { kind: 'ready'; rows: SampleRow[]; columns: string[] }
  | { kind: 'malformed' }
  | { kind: 'oversized' };

export function parseSampleRows(data: Array<{ row_json: unknown }> | null): ParsedSample {
  if (data === null) return { kind: 'ready', rows: [], columns: [] };
  const rawSize = data.reduce((total, row) => total + serializedSize(row.row_json), 0);
  if (rawSize > MAX_SAMPLE_BYTES) return { kind: 'oversized' };
  const rows: SampleRow[] = [];
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    try {
      // AppKit's Arrow fallback decodes JSON-looking STRING cells before they
      // reach the browser, while native JSON_ARRAY delivery keeps the string.
      // Accept both representations so warehouse capabilities do not change
      // the sample contract.
      const value: unknown = typeof item.row_json === 'string' ? JSON.parse(item.row_json) : item.row_json;
      if (!isSampleRow(value)) return { kind: 'malformed' };
      rows.push(value);
      for (const column of Object.keys(value)) {
        if (!seen.has(column)) {
          seen.add(column);
          columns.push(column);
        }
      }
    } catch {
      return { kind: 'malformed' };
    }
  }
  return { kind: 'ready', rows, columns };
}

function serializedSize(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return MAX_SAMPLE_BYTES + 1;
  }
}

export function sampleErrorKind(error: string): 'permission' | 'oversized' | 'generic' {
  const normalized = error.toUpperCase();
  if (
    ['INSUFFICIENT_PRIVILEGES', 'PERMISSION_DENIED', 'TABLE_OR_VIEW_NOT_FOUND', 'RESOURCE_DOES_NOT_EXIST'].some(
      (marker) => normalized.includes(marker)
    )
  ) {
    return 'permission';
  }
  if (normalized.includes('1048576') || normalized.includes('MAX SIZE') || normalized.includes('TOO LARGE')) {
    return 'oversized';
  }
  return 'generic';
}

export function findHighlightedColumn(columns: readonly string[], requested: string | null): string | null {
  if (requested === null) return null;
  return columns.find((candidate) => candidate.toLocaleLowerCase() === requested.toLocaleLowerCase()) ?? null;
}

function isSampleRow(value: unknown): value is SampleRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
