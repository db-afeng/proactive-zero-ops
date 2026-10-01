SELECT
  risk_grade,
  COUNT(*) AS account_count,
  CAST(SUM(effective_ead) AS DOUBLE) AS effective_ead_aud,
  CAST(AVG(utilization_ratio) AS DOUBLE) AS avg_utilization,
  CAST(
    SUM(effective_ead * probability_of_default) / NULLIF(SUM(effective_ead), 0)
    AS DOUBLE
  ) AS weighted_pd
FROM ${catalog}.${silver_schema}.loan_exposure
GROUP BY risk_grade
ORDER BY risk_grade;
