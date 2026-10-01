SELECT
  account_id,
  borrower_id,
  region,
  product_type,
  CAST(utilization_ratio AS DOUBLE) AS utilization_ratio,
  CAST(effective_ead AS DOUBLE) AS effective_ead_aud
FROM ${catalog}.${silver_schema}.loan_exposure
WHERE utilization_ratio >= 0.85
ORDER BY utilization_ratio DESC, effective_ead_aud DESC;
