CREATE OR REFRESH MATERIALIZED VIEW ${catalog}.${bronze_schema}.payment_events (
  CONSTRAINT valid_payment_id EXPECT (payment_id IS NOT NULL) ON VIOLATION FAIL UPDATE,
  CONSTRAINT non_negative_amounts EXPECT (amount_due >= 0 AND amount_paid >= 0) ON VIOLATION DROP ROW
)
COMMENT 'Synthetic contractual payment events used to derive delinquency features.'
AS
SELECT
  payment_id,
  account_id,
  CAST(due_date_raw AS DATE) AS due_date,
  CAST(NULLIF(payment_date_raw, '') AS DATE) AS payment_date,
  CAST(amount_due_raw AS DECIMAL(18, 2)) AS amount_due,
  CAST(amount_paid_raw AS DECIMAL(18, 2)) AS amount_paid
FROM VALUES
  ('P001', 'L001', '2026-08-31', '2026-08-30', '12500.00', '12500.00'),
  ('P002', 'L002', '2026-08-15', '2026-09-19',  '8200.00',  '8200.00'),
  ('P003', 'L003', '2026-08-31', '2026-08-31', '21000.00', '21000.00'),
  ('P004', 'L004', '2026-07-15', '',             '9400.00',     '0.00'),
  ('P005', 'L005', '2026-09-15', '2026-09-20', '15400.00', '15400.00'),
  ('P006', 'L006', '2026-06-20', '',             '6100.00',   '500.00'),
  ('P007', 'L007', '2026-08-31', '2026-08-29',  '4000.00',  '4000.00')
AS seed(payment_id, account_id, due_date_raw, payment_date_raw, amount_due_raw, amount_paid_raw);
