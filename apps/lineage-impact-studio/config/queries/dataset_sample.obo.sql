-- @param asset_reference STRING = samples.tpch.customer
-- @param sample_limit INT = 5
SELECT to_json(struct(*)) AS row_json
FROM IDENTIFIER(:asset_reference)
LIMIT LEAST(CAST(:sample_limit AS INT), 5)
