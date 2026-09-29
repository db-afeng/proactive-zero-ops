const MAX_SAMPLE_BYTES = 750_000;

export type SampleRow = Record<string, unknown>;
export type SampleColumnTypes = Record<string, string>;

export type ParsedSample =
  | { kind: 'ready'; rows: SampleRow[]; columns: string[]; columnTypes: SampleColumnTypes }
  | { kind: 'malformed' }
  | { kind: 'oversized' };

export function parseSampleRows(data: Array<{ row_json: unknown; row_type: unknown }> | null): ParsedSample {
  if (data === null) return { kind: 'ready', rows: [], columns: [], columnTypes: {} };
  const rawSize = data.reduce((total, row) => total + serializedSize(row.row_json) + serializedSize(row.row_type), 0);
  if (rawSize > MAX_SAMPLE_BYTES) return { kind: 'oversized' };
  const rows: SampleRow[] = [];
  let columnTypes: SampleColumnTypes | null = null;
  for (const item of data) {
    try {
      // AppKit's Arrow fallback decodes JSON-looking STRING cells before they
      // reach the browser, while native JSON_ARRAY delivery keeps the string.
      // Accept both representations so warehouse capabilities do not change
      // the sample contract.
      const value: unknown = typeof item.row_json === 'string' ? JSON.parse(item.row_json) : item.row_json;
      if (!isSampleRow(value)) return { kind: 'malformed' };
      const parsedTypes = parseStructType(item.row_type);
      if (parsedTypes === null) return { kind: 'malformed' };
      if (columnTypes === null) columnTypes = parsedTypes;
      if (!sameColumnTypes(columnTypes, parsedTypes)) return { kind: 'malformed' };
      if (Object.keys(value).some((column) => !Object.hasOwn(parsedTypes, column))) return { kind: 'malformed' };
      rows.push(value);
    } catch {
      return { kind: 'malformed' };
    }
  }
  const resolvedTypes = columnTypes ?? {};
  return { kind: 'ready', rows, columns: Object.keys(resolvedTypes), columnTypes: resolvedTypes };
}

export function parseStructType(value: unknown): SampleColumnTypes | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^struct</i.test(normalized) || !normalized.endsWith('>')) return null;
  const fields = splitTopLevel(normalized.slice(normalized.indexOf('<') + 1, -1), ',');
  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const field of fields) {
    const colon = findTopLevelDelimiter(field, ':');
    if (colon < 1) return null;
    const column = parseFieldName(field.slice(0, colon));
    const type = field.slice(colon + 1).trim();
    if (column === null || type.length === 0 || seen.has(column)) return null;
    seen.add(column);
    entries.push([column, type]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function splitTopLevel(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let angleDepth = 0;
  let parenthesisDepth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '`') {
      if (quoted && value[index + 1] === '`') {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted) {
      if (character === '<') angleDepth += 1;
      else if (character === '>') angleDepth -= 1;
      else if (character === '(') parenthesisDepth += 1;
      else if (character === ')') parenthesisDepth -= 1;
      else if (character === delimiter && angleDepth === 0 && parenthesisDepth === 0) {
        parts.push(value.slice(start, index).trim());
        start = index + 1;
      }
      if (angleDepth < 0 || parenthesisDepth < 0) return [];
    }
  }
  if (quoted || angleDepth !== 0 || parenthesisDepth !== 0) return [];
  parts.push(value.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

function findTopLevelDelimiter(value: string, delimiter: string): number {
  let angleDepth = 0;
  let parenthesisDepth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '`') {
      if (quoted && value[index + 1] === '`') index += 1;
      else quoted = !quoted;
    } else if (!quoted) {
      if (character === '<') angleDepth += 1;
      else if (character === '>') angleDepth -= 1;
      else if (character === '(') parenthesisDepth += 1;
      else if (character === ')') parenthesisDepth -= 1;
      else if (character === delimiter && angleDepth === 0 && parenthesisDepth === 0) return index;
    }
  }
  return -1;
}

function parseFieldName(value: string): string | null {
  const normalized = value.trim();
  if (normalized.startsWith('`') && normalized.endsWith('`')) {
    return normalized.slice(1, -1).replaceAll('``', '`');
  }
  return normalized.length > 0 ? normalized : null;
}

function sameColumnTypes(left: SampleColumnTypes, right: SampleColumnTypes): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([column, type], index) => {
      const rightEntry = rightEntries[index];
      return rightEntry?.[0] === column && rightEntry[1] === type;
    })
  );
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
