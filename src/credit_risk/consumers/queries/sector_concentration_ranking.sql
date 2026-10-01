SELECT
  region,
  industry_sector,
  borrower_count,
  CAST(sector_ead AS DOUBLE) AS sector_ead_aud,
  CAST(sector_net_ead AS DOUBLE) AS sector_net_ead_aud,
  CAST(concentration_ratio AS DOUBLE) AS concentration_ratio
FROM ${catalog}.${gold_schema}.sector_concentration
ORDER BY concentration_ratio DESC, sector_ead_aud DESC;
