# Proactive Zero Ops: Credit-Risk Lineage Guard

This repository demonstrates a pull-request gate that combines Databricks Unity Catalog
column/table lineage with an LLM served through Databricks AI Gateway. The included synthetic
credit-risk pipeline is deliberately non-regulatory and must not be used to make lending or
capital decisions.

## Architecture

The Databricks Asset Bundle creates three schemas in `proactive_zero_ops_catalog`, a triggered serverless Lakeflow
Declarative Pipeline, and an X-Small serverless SQL warehouse. Twelve materialized views model
borrowers, facilities, payments, credit scores, collateral, exposure at default, expected loss,
watchlist signals, and sector concentration.

The GitHub check reads a PR diff without executing PR code, discovers downstream relationships
from `system.access.column_lineage` and `system.access.table_lineage`, and asks an AI Gateway model
for a structured impact assessment. Only high/critical findings with a verified lineage path and
confidence of at least 0.80 block. Missing coverage or unavailable dependencies fail closed.

## Local development

```bash
uv sync --extra dev
uv run pytest
uv run ruff check .
databricks bundle validate --strict --target dev --profile proactive-zero-ops
```

Deploy and run the baseline after authenticating the selected profile:

```bash
databricks bundle deploy --target dev --profile proactive-zero-ops
databricks bundle run credit_risk_pipeline --target dev --profile proactive-zero-ops
```

Run the guard against two commits:

```bash
export DATABRICKS_AUTH_TYPE=github-oidc
export DATABRICKS_HOST=https://fevm-proactive-zero-ops.cloud.databricks.com
export DATABRICKS_CLIENT_ID=<service-principal-application-id>
export DATABRICKS_WAREHOUSE_ID=<warehouse-id>
export DATABRICKS_SERVING_ENDPOINT=<endpoint-name>

uv run python -m lineage_guard assess \
  --base <base-sha> \
  --head <head-sha> \
  --output assessment.json \
  --markdown-output assessment.md
```

The command exits `0` for pass/warn, `1` for a grounded block, and `2` when the assessment cannot
be performed safely. See [docs/oidc-setup.md](docs/oidc-setup.md) for the administrator checkpoint.

The deployed demo uses pipeline `ce5221c8-5a2a-42ec-b37c-70c0d1411fbb` and SQL warehouse
`a812711ddc3964b1`. Resource IDs remain stable across normal bundle updates but should be checked
with `databricks bundle summary` after a destructive redeployment.
