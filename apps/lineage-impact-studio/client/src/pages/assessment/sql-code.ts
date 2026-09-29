export type SqlTokenKind = 'plain' | 'keyword' | 'function' | 'string' | 'number' | 'comment' | 'identifier';

export interface SqlToken {
  value: string;
  kind: SqlTokenKind;
}

const KEYWORDS = new Set(
  [
    'ALL',
    'AND',
    'AS',
    'ASC',
    'BETWEEN',
    'BY',
    'CASE',
    'CAST',
    'DECIMAL',
    'DESC',
    'DISTINCT',
    'ELSE',
    'END',
    'FALSE',
    'FROM',
    'FULL',
    'GROUP',
    'HAVING',
    'IN',
    'INNER',
    'IS',
    'JOIN',
    'LEFT',
    'LIKE',
    'LIMIT',
    'NOT',
    'NULL',
    'ON',
    'OR',
    'ORDER',
    'OUTER',
    'OVER',
    'PARTITION',
    'RIGHT',
    'SELECT',
    'THEN',
    'TRUE',
    'UNION',
    'WHEN',
    'WHERE',
    'WITH',
  ].map((keyword) => keyword.toUpperCase())
);

const TOKEN_PATTERN =
  /(--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|:[A-Za-z_][\w$]*|\b[A-Za-z_][\w$]*\b|<>|!=|<=|>=|=>|==|[-+*/%=<>&|^~]+|[(),.;]|\s+|.)/gi;

export function formatSparkSql(value: string): string {
  if (!hasBalancedQuotes(value)) return value;
  const tokens = (value.match(TOKEN_PATTERN) ?? [value]).filter((token) => !/^\s+$/.test(token));
  if (tokens.length === 0) return value;

  const lines: string[] = [];
  const parentheses: boolean[] = [];
  let indent = 0;
  let current = '';

  const flush = () => {
    const line = current.trimEnd();
    if (line.trim().length > 0) lines.push(line);
    current = '';
  };
  const startLine = () => {
    if (current.length === 0) current = '  '.repeat(indent);
  };
  const appendWord = (word: string) => {
    startLine();
    if (current.trim().length > 0 && !/[\s.(]$/.test(current)) current += ' ';
    current += word;
  };

  tokens.forEach((token, index) => {
    const kind = tokenKind(token, index, tokens);
    const formatted = kind === 'keyword' || kind === 'function' ? token.toUpperCase() : token;
    const upper = formatted.toUpperCase();
    const previous = tokens[index - 1]?.toUpperCase();

    if (upper === 'WHEN' || upper === 'ELSE') {
      flush();
      startLine();
      current += upper;
      return;
    }
    if (upper === 'END') {
      flush();
      indent = Math.max(0, indent - 1);
      startLine();
      current += upper;
      return;
    }
    if (upper === 'CASE') {
      appendWord(upper);
      flush();
      indent += 1;
      return;
    }
    if (upper === 'THEN') {
      if (current.length + formatted.length + 1 > 44) {
        flush();
        current = `${'  '.repeat(indent + 1)}THEN`;
      } else {
        appendWord(upper);
      }
      return;
    }
    if (['FROM', 'WHERE', 'HAVING', 'LIMIT', 'UNION', 'JOIN'].includes(upper)) {
      flush();
      appendWord(upper);
      return;
    }
    if ((upper === 'GROUP' || upper === 'ORDER') && tokens[index + 1]?.toUpperCase() === 'BY') {
      flush();
      appendWord(upper);
      return;
    }
    if ((upper === 'AND' || upper === 'OR') && current.length > 44) {
      flush();
      appendWord(upper);
      return;
    }
    if (token === '(') {
      current = current.trimEnd();
      current += '(';
      const multiline = previous === 'CAST';
      parentheses.push(multiline);
      if (multiline) {
        flush();
        indent += 1;
      }
      return;
    }
    if (token === ')') {
      const multiline = parentheses.pop() ?? false;
      if (multiline) {
        flush();
        indent = Math.max(0, indent - 1);
        startLine();
      }
      current = current.trimEnd();
      current += ')';
      return;
    }
    if (token === '.') {
      current = current.trimEnd();
      current += '.';
      return;
    }
    if (token === ',') {
      current = current.trimEnd();
      current += ', ';
      return;
    }
    if (/^[-+*/%=<>!&|^~]+$/.test(token)) {
      startLine();
      const unary = token === '-' && (previous === undefined || ['(', ',', 'THEN', 'ELSE'].includes(previous));
      current = current.trimEnd();
      current += unary ? token : ` ${token} `;
      return;
    }
    if (kind === 'comment') {
      appendWord(formatted);
      if (formatted.startsWith('--')) flush();
      return;
    }
    appendWord(formatted);
  });

  flush();
  return lines.flatMap(wrapLongSqlLine).join('\n');
}

function hasBalancedQuotes(value: string): boolean {
  let quote: "'" | '"' | '`' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === null) {
      if (character === "'" || character === '"' || character === '`') quote = character;
      continue;
    }
    if (character !== quote) continue;
    if (value[index + 1] === quote) {
      index += 1;
      continue;
    }
    quote = null;
  }
  return quote === null;
}

function wrapLongSqlLine(line: string): string[] {
  if (line.length <= 44) return [line];
  const indent = line.match(/^\s*/)?.[0] ?? '';
  const content = line.slice(indent.length);
  const thenAt = content.indexOf(' THEN ');
  if (thenAt >= 0) {
    return [`${indent}${content.slice(0, thenAt)}`, `${indent}  THEN ${content.slice(thenAt + 6)}`];
  }

  const parts = content.split(/ ([+*/-]) /);
  if (parts.length < 3) return [line];
  const wrapped = [`${indent}${parts[0]}`];
  for (let index = 1; index < parts.length; index += 2) {
    wrapped.push(`${indent}  ${parts[index]} ${parts[index + 1] ?? ''}`.trimEnd());
  }
  return wrapped;
}

export function tokenizeSql(value: string): SqlToken[] {
  const rawTokens = value.match(TOKEN_PATTERN) ?? [value];
  return rawTokens.map((token, index) => ({ value: token, kind: tokenKind(token, index, rawTokens) }));
}

function tokenKind(token: string, index: number, tokens: string[]): SqlTokenKind {
  if (/^\s+$/.test(token) || /^[(),.;=<>!+*/%&|^~-]+$/.test(token)) return 'plain';
  if (token.startsWith('--') || token.startsWith('/*')) return 'comment';
  if (token.startsWith("'")) return 'string';
  if (/^\d/.test(token)) return 'number';
  if (token.startsWith('"') || token.startsWith('`') || token.startsWith(':')) return 'identifier';

  const upper = token.toUpperCase();
  if (KEYWORDS.has(upper)) return 'keyword';
  const next = tokens.slice(index + 1).find((candidate) => !/^\s+$/.test(candidate));
  return next === '(' ? 'function' : 'plain';
}
