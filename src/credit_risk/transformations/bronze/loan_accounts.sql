CREATE OR REFRESH MATERIALIZED VIEW ${catalog}.${bronze_schema}.loan_accounts (
  CONSTRAINT valid_account_id EXPECT (account_id IS NOT NULL) ON VIOLATION FAIL UPDATE,
  CONSTRAINT valid_credit_limit EXPECT (credit_limit > 0) ON VIOLATION DROP ROW,
  CONSTRAINT non_negative_balance EXPECT (outstanding_balance >= 0) ON VIOLATION DROP ROW,
  CONSTRAINT valid_days_past_due EXPECT (days_past_due BETWEEN 0 AND 180)
)
COMMENT 'Synthetic loan account snapshots. Amount columns are denominated in Australian dollars.'
AS
SELECT
  account_id,
  borrower_id,
  product_type,
  CAST(credit_limit_raw AS DECIMAL(18, 2)) AS credit_limit,
  CAST(outstanding_balance_raw AS DECIMAL(18, 2)) AS outstanding_balance,
  CAST(undrawn_commitment_raw AS DECIMAL(18, 2)) AS undrawn_commitment,
  CAST(days_past_due_raw AS INT) AS days_past_due,
  CAST(as_of_date_raw AS DATE) AS as_of_date
FROM VALUES
  ('L001', 'B001', 'Term Loan',       '500000.00', '345000.00', '0.00',      '0',  '2026-09-20'),
  ('L002', 'B002', 'Revolver',        '250000.00', '210000.00', '40000.00',  '35', '2026-09-20'),
  ('L003', 'B003', 'Term Loan',      '1200000.00', '760000.00', '0.00',      '0',  '2026-09-20'),
  ('L004', 'B004', 'Revolver',        '400000.00', '365000.00', '35000.00',  '67', '2026-09-20'),
  ('L005', 'B005', 'Trade Finance',   '850000.00', '510000.00', '180000.00', '5',  '2026-09-20'),
  ('L006', 'B006', 'Term Loan',       '180000.00', '172000.00', '0.00',      '92', '2026-09-20'),
  ('L007', 'B001', 'Revolver',        '300000.00', '120000.00', '120000.00', '0',  '2026-09-20')
AS seed(
  account_id,
  borrower_id,
  product_type,
  credit_limit_raw,
  outstanding_balance_raw,
  undrawn_commitment_raw,
  days_past_due_raw,
  as_of_date_raw
);
