CREATE OR REFRESH MATERIALIZED VIEW ${catalog}.${bronze_schema}.borrowers (
  CONSTRAINT valid_borrower_id EXPECT (borrower_id IS NOT NULL) ON VIOLATION FAIL UPDATE,
  CONSTRAINT positive_income EXPECT (annual_income > 0) ON VIOLATION DROP ROW
)
COMMENT 'Synthetic borrower master data for the credit-risk lineage demo.'
AS
SELECT
  borrower_id,
  region,
  industry_sector,
  CAST(annual_income_raw AS DECIMAL(18, 2)) AS annual_income,
  risk_segment,
  CAST(opened_date_raw AS DATE) AS opened_date
FROM VALUES
  ('B001', 'NSW', 'Manufacturing', '145000.00', 'SME', '2018-04-12'),
  ('B002', 'VIC', 'Retail',         '92000.00', 'SME', '2020-08-03'),
  ('B003', 'QLD', 'Healthcare',    '220000.00', 'Corporate', '2016-02-19'),
  ('B004', 'WA',  'Construction',  '118000.00', 'SME', '2021-11-24'),
  ('B005', 'NSW', 'Technology',    '310000.00', 'Corporate', '2017-06-07'),
  ('B006', 'SA',  'Hospitality',    '78000.00', 'SME', '2022-03-15')
AS seed(borrower_id, region, industry_sector, annual_income_raw, risk_segment, opened_date_raw);
