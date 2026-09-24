CREATE OR REFRESH MATERIALIZED VIEW ${catalog}.${bronze_schema}.credit_scores (
  CONSTRAINT valid_bureau_score EXPECT (bureau_score BETWEEN 300 AND 850) ON VIOLATION DROP ROW
)
COMMENT 'Synthetic bureau credit scores for borrower risk grading.'
AS
SELECT
  borrower_id,
  CAST(bureau_score_raw AS INT) AS bureau_score,
  CAST(score_date_raw AS DATE) AS score_date
FROM VALUES
  ('B001', '728', '2026-09-01'),
  ('B002', '662', '2026-09-03'),
  ('B003', '781', '2026-09-02'),
  ('B004', '618', '2026-09-04'),
  ('B005', '744', '2026-09-01'),
  ('B006', '571', '2026-09-05')
AS seed(borrower_id, bureau_score_raw, score_date_raw);
