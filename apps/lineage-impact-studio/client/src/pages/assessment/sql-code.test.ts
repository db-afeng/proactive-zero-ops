import { describe, expect, it } from 'vitest';

import { formatSparkSql, tokenizeSql } from './sql-code';

describe('SQL code presentation', () => {
  it('formats Spark SQL expressions into readable clauses', () => {
    const formatted = formatSparkSql(
      "CAST(a.balance + a.commitment * CASE WHEN a.kind = 'Revolver' THEN 0.75 ELSE 0 END AS DECIMAL(18, 2))"
    );

    expect(formatted).toContain('CASE\n');
    expect(formatted).toContain("  WHEN a.kind = 'Revolver' THEN 0.75");
    expect(formatted).toContain('END AS DECIMAL(18, 2)');
  });

  it('wraps long arithmetic and CASE branches at SQL boundaries', () => {
    const formatted = formatSparkSql(
      "CAST(a.outstanding_balance + a.undrawn_commitment * CASE WHEN a.product_type = 'Trade Finance' THEN 0.5000 ELSE 0 END AS DECIMAL(18, 2))"
    );

    expect(formatted).toContain('  a.outstanding_balance\n    + a.undrawn_commitment\n    * CASE');
    expect(formatted).toContain("    WHEN a.product_type = 'Trade Finance'\n      THEN 0.5000");
  });

  it('falls back to the authorized expression when formatting cannot parse it', () => {
    const invalid = "CASE WHEN account_type = '";
    expect(formatSparkSql(invalid)).toBe(invalid);
  });

  it('classifies SQL syntax for semantic token coloring', () => {
    const tokens = tokenizeSql("CASE WHEN amount > 10 THEN 'large' END");

    expect(tokens).toContainEqual({ value: 'CASE', kind: 'keyword' });
    expect(tokens).toContainEqual({ value: '10', kind: 'number' });
    expect(tokens).toContainEqual({ value: "'large'", kind: 'string' });
  });
});
