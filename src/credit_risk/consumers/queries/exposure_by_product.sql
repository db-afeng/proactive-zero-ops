SELECT
  product_type,
  COUNT(*) AS account_count,
  CAST(SUM(drawn_exposure) AS DOUBLE) AS drawn_exposure_aud,
  CAST(SUM(effective_ead) AS DOUBLE) AS effective_ead_aud,
  CAST(AVG(utilization_ratio) AS DOUBLE) AS avg_utilization
FROM ${catalog}.${silver_schema}.loan_exposure
GROUP BY product_type
ORDER BY effective_ead_aud DESC;
