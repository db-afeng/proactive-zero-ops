import type { ReactNode } from 'react';

export function CodeIdentifier({ value, className = '' }: { value: string; className?: string }) {
  return <code className={`identifier-code ${className}`}>{value}</code>;
}

export function IdentifierText({ text, identifiers }: { text: string; identifiers: readonly string[] }) {
  if (identifiers.length === 0) return text;
  const pattern = new RegExp(`(?<![\\w.])(${identifiers.map(escapeRegExp).join('|')})(?![\\w.])`, 'g');
  const parts: ReactNode[] = [];
  let previousEnd = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(previousEnd, match.index));
    parts.push(<CodeIdentifier key={match.index} value={match[0]} />);
    previousEnd = match.index + match[0].length;
  }
  parts.push(text.slice(previousEnd));
  return parts;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
