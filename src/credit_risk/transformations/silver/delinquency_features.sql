CREATE OR REFRESH MATERIALIZED VIEW ${catalog}.${silver_schema}.delinquency_features
COMMENT 'Payment-derived arrears features combined with the current account delinquency state.'
AS
WITH payment_summary AS (
  SELECT
    account_id,
    COUNT(*) AS scheduled_payment_count,
    SUM(CASE WHEN amount_paid < amount_due THEN 1 ELSE 0 END) AS missed_payment_count,
    CAST(SUM(GREATEST(amount_due - amount_paid, 0)) AS DECIMAL(18, 2)) AS unpaid_amount,
    MAX(payment_date) AS most_recent_payment_date
  FROM ${catalog}.${bronze_schema}.payment_events
  GROUP BY account_id
)
SELECT
  a.account_id,
  a.borrower_id,
  a.as_of_date,
  a.days_past_due,
  CASE
    WHEN a.days_past_due = 0 THEN 'CURRENT'
    WHEN a.days_past_due <= 29 THEN '1-29 DPD'
    WHEN a.days_past_due <= 59 THEN '30-59 DPD'
    WHEN a.days_past_due <= 89 THEN '60-89 DPD'
    ELSE '90+ DPD'
  END AS delinquency_bucket,
  COALESCE(p.scheduled_payment_count, 0) AS scheduled_payment_count,
  COALESCE(p.missed_payment_count, 0) AS missed_payment_count,
  COALESCE(p.unpaid_amount, CAST(0 AS DECIMAL(18, 2))) AS unpaid_amount,
  p.most_recent_payment_date
FROM ${catalog}.${bronze_schema}.loan_accounts a
LEFT JOIN payment_summary p USING (account_id);
