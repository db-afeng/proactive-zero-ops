CREATE OR REFRESH MATERIALIZED VIEW ${catalog}.${gold_schema}.delinquency_watchlist
COMMENT 'Account watchlist based on delinquency, high utilization, or weak borrower grade.'
AS
SELECT
  e.as_of_date,
  e.account_id,
  e.borrower_id,
  e.region,
  e.industry_sector,
  e.product_type,
  e.risk_grade,
  e.drawn_exposure,
  e.effective_ead,
  e.utilization_ratio,
  d.days_past_due,
  d.delinquency_bucket,
  d.missed_payment_count,
  d.unpaid_amount,
  CASE
    WHEN d.days_past_due >= 90 THEN 'CRITICAL'
    WHEN d.days_past_due >= 30 OR e.risk_grade = 'D' THEN 'HIGH'
    ELSE 'ELEVATED'
  END AS watchlist_priority
FROM ${catalog}.${silver_schema}.loan_exposure e
JOIN ${catalog}.${silver_schema}.delinquency_features d USING (account_id, borrower_id, as_of_date)
WHERE d.days_past_due >= 30
   OR e.utilization_ratio >= 0.8500
   OR e.risk_grade = 'D';
