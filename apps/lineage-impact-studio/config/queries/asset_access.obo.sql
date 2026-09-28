-- @param assets_json STRING = [{"ordinal":0,"asset_reference":"proactive_zero_ops_catalog.proactive_zero_ops_bronze.borrowers","catalog_name":"proactive_zero_ops_catalog","schema_name":"proactive_zero_ops_bronze","asset_name":"borrowers"}]
WITH requested AS (
  SELECT
    asset.ordinal,
    asset.asset_reference,
    asset.catalog_name,
    asset.schema_name,
    asset.asset_name
  FROM EXPLODE(
    FROM_JSON(
      :assets_json,
      'ARRAY<STRUCT<ordinal: INT, asset_reference: STRING, catalog_name: STRING, schema_name: STRING, asset_name: STRING>>'
    )
  ) AS requested(asset)
),
selectable AS (
  SELECT DISTINCT
    table_catalog,
    table_schema,
    table_name
  FROM system.information_schema.table_privileges
  WHERE privilege_type IN ('SELECT', 'ALL_PRIVILEGES')
    AND (
      grantee = CURRENT_USER()
      OR IS_ACCOUNT_GROUP_MEMBER(grantee)
    )
)
SELECT
  requested.ordinal,
  requested.asset_reference,
  selectable.table_name IS NOT NULL AS can_select,
  COALESCE(visible_table.table_type, 'UNKNOWN') AS asset_type
FROM requested
LEFT JOIN selectable
  ON selectable.table_catalog = requested.catalog_name
  AND selectable.table_schema = requested.schema_name
  AND selectable.table_name = requested.asset_name
LEFT JOIN system.information_schema.tables AS visible_table
  ON visible_table.table_catalog = requested.catalog_name
  AND visible_table.table_schema = requested.schema_name
  AND visible_table.table_name = requested.asset_name
ORDER BY requested.ordinal
