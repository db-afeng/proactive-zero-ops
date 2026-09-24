CREATE OR REFRESH MATERIALIZED VIEW ${catalog}.${silver_schema}.loan_exposure (
  CONSTRAINT non_negative_ead EXPECT (effective_ead >= 0) ON VIOLATION FAIL UPDATE,
  CONSTRAINT sensible_utilization EXPECT (utilization_ratio BETWEEN 0 AND 2)
)
COMMENT 'Account-level drawn exposure, undrawn conversion, utilization, and exposure at default.'
AS
SELECT
  a.account_id,
  a.borrower_id,
  a.product_type,
  p.region,
  p.industry_sector,
  p.risk_segment,
  p.risk_grade,
  p.probability_of_default,
  a.as_of_date,
  a.days_past_due,
  a.credit_limit,
  a.outstanding_balance AS drawn_exposure,
  a.undrawn_commitment,
  CAST(CASE
    WHEN a.product_type = 'Revolver' THEN 0.7500
    WHEN a.product_type = 'Trade Finance' THEN 0.5000
    ELSE 0.0000
  END AS DECIMAL(5, 4)) AS credit_conversion_factor,
  CAST(
    a.outstanding_balance + a.undrawn_commitment *
      CASE
        WHEN a.product_type = 'Revolver' THEN 0.7500
        WHEN a.product_type = 'Trade Finance' THEN 0.5000
        ELSE 0.0000
      END
    AS DECIMAL(18, 2)
  ) AS effective_ead,
  CAST(a.outstanding_balance / NULLIF(a.credit_limit, 0) AS DECIMAL(10, 6)) AS utilization_ratio
FROM ${catalog}.${bronze_schema}.loan_accounts a
JOIN ${catalog}.${silver_schema}.borrower_risk_profile p USING (borrower_id);
