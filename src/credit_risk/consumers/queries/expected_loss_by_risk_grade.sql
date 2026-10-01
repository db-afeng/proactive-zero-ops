SELECT
  risk_grade,
  SUM(account_count) AS account_count,
  CAST(SUM(total_ead) AS DOUBLE) AS total_ead_aud,
  CAST(SUM(expected_loss) AS DOUBLE) AS expected_loss_aud,
  CAST(SUM(expected_loss) / NULLIF(SUM(total_ead), 0) AS DOUBLE) AS loss_rate
FROM ${catalog}.${gold_schema}.portfolio_expected_loss
GROUP BY risk_grade
ORDER BY risk_grade;
