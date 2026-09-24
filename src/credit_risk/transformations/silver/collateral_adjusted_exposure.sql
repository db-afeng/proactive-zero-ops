CREATE OR REFRESH MATERIALIZED VIEW ${catalog}.${silver_schema}.collateral_adjusted_exposure (
  CONSTRAINT valid_lgd EXPECT (loss_given_default BETWEEN 0 AND 1) ON VIOLATION FAIL UPDATE
)
COMMENT 'Exposure adjusted for collateral haircuts with an illustrative loss-given-default estimate.'
AS
WITH collateral_summary AS (
  SELECT
    account_id,
    CAST(SUM(appraised_value * (1 - haircut_pct)) AS DECIMAL(18, 2)) AS adjusted_collateral_value
  FROM ${catalog}.${bronze_schema}.collateral
  GROUP BY account_id
)
SELECT
  e.account_id,
  e.borrower_id,
  e.as_of_date,
  e.product_type,
  e.region,
  e.industry_sector,
  e.risk_segment,
  e.risk_grade,
  e.probability_of_default,
  e.days_past_due,
  e.utilization_ratio,
  e.effective_ead,
  COALESCE(c.adjusted_collateral_value, CAST(0 AS DECIMAL(18, 2))) AS adjusted_collateral_value,
  CAST(GREATEST(e.effective_ead - COALESCE(c.adjusted_collateral_value, 0), 0) AS DECIMAL(18, 2)) AS net_ead,
  CAST(CASE
    WHEN e.effective_ead = 0 THEN 0
    WHEN c.adjusted_collateral_value IS NULL THEN 0.6500
    ELSE GREATEST(0.2000, 1 - c.adjusted_collateral_value / e.effective_ead)
  END AS DECIMAL(8, 6)) AS loss_given_default
FROM ${catalog}.${silver_schema}.loan_exposure e
LEFT JOIN collateral_summary c USING (account_id);
