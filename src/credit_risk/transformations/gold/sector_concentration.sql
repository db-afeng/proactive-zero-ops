CREATE OR REFRESH MATERIALIZED VIEW ${catalog}.${gold_schema}.sector_concentration
COMMENT 'Portfolio exposure and concentration share by industry sector and region.'
AS
WITH sector_exposure AS (
  SELECT
    as_of_date,
    region,
    industry_sector,
    COUNT(DISTINCT borrower_id) AS borrower_count,
    CAST(SUM(effective_ead) AS DECIMAL(20, 2)) AS sector_ead,
    CAST(SUM(net_ead) AS DECIMAL(20, 2)) AS sector_net_ead
  FROM ${catalog}.${silver_schema}.collateral_adjusted_exposure
  GROUP BY ALL
),
portfolio_totals AS (
  SELECT
    as_of_date,
    CAST(SUM(effective_ead) AS DECIMAL(20, 2)) AS portfolio_ead
  FROM ${catalog}.${silver_schema}.collateral_adjusted_exposure
  GROUP BY as_of_date
)
SELECT
  s.as_of_date,
  s.region,
  s.industry_sector,
  s.borrower_count,
  s.sector_ead,
  s.sector_net_ead,
  p.portfolio_ead,
  CAST(s.sector_ead / NULLIF(p.portfolio_ead, 0) AS DECIMAL(10, 6)) AS concentration_ratio
FROM sector_exposure s
JOIN portfolio_totals p USING (as_of_date);
