CREATE OR REFRESH MATERIALIZED VIEW ${catalog}.${gold_schema}.portfolio_expected_loss
CLUSTER BY (as_of_date, risk_grade)
COMMENT 'Illustrative portfolio expected-credit-loss summary; not an IFRS 9 or regulatory calculation.'
AS
SELECT
  as_of_date,
  risk_grade,
  risk_segment,
  region,
  industry_sector,
  product_type,
  COUNT(DISTINCT account_id) AS account_count,
  CAST(SUM(effective_ead) AS DECIMAL(20, 2)) AS total_ead,
  CAST(SUM(net_ead) AS DECIMAL(20, 2)) AS total_net_ead,
  CAST(SUM(net_ead * probability_of_default * loss_given_default) AS DECIMAL(20, 2)) AS expected_loss,
  CAST(SUM(effective_ead * probability_of_default) / NULLIF(SUM(effective_ead), 0) AS DECIMAL(10, 6)) AS weighted_pd,
  CAST(SUM(effective_ead * loss_given_default) / NULLIF(SUM(effective_ead), 0) AS DECIMAL(10, 6)) AS weighted_lgd
FROM ${catalog}.${silver_schema}.collateral_adjusted_exposure
GROUP BY ALL;
