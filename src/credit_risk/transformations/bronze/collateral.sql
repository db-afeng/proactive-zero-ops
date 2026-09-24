CREATE OR REFRESH MATERIALIZED VIEW ${catalog}.${bronze_schema}.collateral (
  CONSTRAINT positive_appraisal EXPECT (appraised_value > 0) ON VIOLATION DROP ROW,
  CONSTRAINT valid_haircut EXPECT (haircut_pct BETWEEN 0 AND 1) ON VIOLATION DROP ROW
)
COMMENT 'Synthetic collateral valuations and prudential haircuts.'
AS
SELECT
  collateral_id,
  account_id,
  collateral_type,
  CAST(appraised_value_raw AS DECIMAL(18, 2)) AS appraised_value,
  CAST(haircut_pct_raw AS DECIMAL(5, 4)) AS haircut_pct,
  CAST(valuation_date_raw AS DATE) AS valuation_date
FROM VALUES
  ('C001', 'L001', 'Commercial Property', '410000.00', '0.2500', '2026-08-15'),
  ('C002', 'L002', 'Inventory',            '90000.00', '0.5000', '2026-09-01'),
  ('C003', 'L003', 'Commercial Property', '950000.00', '0.2000', '2026-08-20'),
  ('C004', 'L004', 'Equipment',           '160000.00', '0.4500', '2026-07-30'),
  ('C005', 'L005', 'Receivables',         '420000.00', '0.3500', '2026-09-10'),
  ('C006', 'L006', 'Hospitality Property','130000.00', '0.5500', '2026-06-28')
AS seed(collateral_id, account_id, collateral_type, appraised_value_raw, haircut_pct_raw, valuation_date_raw);
