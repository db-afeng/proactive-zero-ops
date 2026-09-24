CREATE OR REFRESH MATERIALIZED VIEW ${catalog}.${silver_schema}.borrower_risk_profile (
  CONSTRAINT valid_probability_of_default EXPECT (probability_of_default BETWEEN 0 AND 1) ON VIOLATION FAIL UPDATE
)
COMMENT 'Borrower attributes enriched with an illustrative score band and probability of default.'
AS
SELECT
  b.borrower_id,
  b.region,
  b.industry_sector,
  b.annual_income,
  b.risk_segment,
  s.bureau_score,
  s.score_date,
  CASE
    WHEN s.bureau_score >= 760 THEN 'A'
    WHEN s.bureau_score >= 700 THEN 'B'
    WHEN s.bureau_score >= 640 THEN 'C'
    ELSE 'D'
  END AS risk_grade,
  CAST(CASE
    WHEN s.bureau_score >= 760 THEN 0.0050
    WHEN s.bureau_score >= 700 THEN 0.0150
    WHEN s.bureau_score >= 640 THEN 0.0450
    ELSE 0.1200
  END AS DECIMAL(8, 6)) AS probability_of_default
FROM ${catalog}.${bronze_schema}.borrowers b
JOIN ${catalog}.${bronze_schema}.credit_scores s USING (borrower_id);
