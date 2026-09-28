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

The GitHub check reads both Git revisions without executing PR code. It safely discovers bundle
jobs, pipelines, task sources, and library globs for a trusted CI-selected target, then resolves
static catalog and schema substitutions. No manually maintained file-to-table map or authored data
contract is required.

SQL is parsed deterministically with SQLGlot's Databricks dialect. The guard compares normalized
syntax trees and extracts outputs, inputs, columns, expressions, joins, filters, and explicit casts,
so formatting-only changes do not become impact findings. Both revisions are inspected, including
bundle configuration changes, source-path changes, additions, deletions, and renames. Unsupported
Lakeflow or dynamic bundle syntax is reported as incomplete coverage; it is never silently skipped.

Proposed-code dependencies remain distinct from relationships observed in
`system.access.column_lineage` and `system.access.table_lineage`. The observed graph may include
downstream consumers outside this repository. The model receives structured SQL changes, source
evidence, available downstream definitions, and verified paths only to interpret likely breakage or
meaning changes. Dataset identity, dependency paths, discovery completeness, and the final gate are
checked deterministically. Discovery certainty is reported separately from the model's impact
confidence, and model output cannot repair unresolved discovery. Missing lineage is a visible
coverage limitation, not evidence of no impact.

Only high/critical findings with a verified downstream path and confidence of at least 0.80 block.
Unresolved discovery, missing required evidence, or unavailable dependencies fail closed.

## Trust and disclosure boundary

The required check uses `pull_request_target`. It installs the checker from the trusted base commit
and fetches the proposed commit only as Git data. It does not run PR-defined Python, bundle
generators, mutators, build commands, validation, or planning. Declarative YAML and SQL are parsed as
data; executable or unresolved configuration produces an incomplete assessment.

GitHub comments, job summaries, logs, and downloadable artifacts contain the same small public
projection: outcome, an approved generic message, and a random opaque assessment reference. SQL,
file names, asset identities, owners, lineage paths, model text, and detailed errors are restricted.
On the v1 runner, full evidence is written only to an owner-only directory (`0700`) with owner-only
records (`0600`) and is never uploaded to GitHub. A multi-user evidence service must authenticate
each viewer and check that viewer's permission for the requested reference.

`lineage_guard.yml` contains only the optional maximum lineage depth; omitting it uses the trusted
default. Targets and Databricks connections come from CI, while enforcement thresholds and
disclosure rules remain in trusted checker code rather than pull-request configuration.

## Local development

```bash
uv sync --extra dev
uv run pytest
uv run ruff check .
databricks bundle validate --strict --target dev --profile fe-sandbox-proactive-zero-ops
```

Deploy and run the baseline after authenticating the selected profile:

```bash
databricks bundle deploy --target dev --profile fe-sandbox-proactive-zero-ops
databricks bundle run credit_risk_pipeline --target dev --profile fe-sandbox-proactive-zero-ops
```

Run the guard against two commits:

```bash
export DATABRICKS_CONFIG_PROFILE=fe-sandbox-proactive-zero-ops
export DATABRICKS_WAREHOUSE_ID=<warehouse-id>
export DATABRICKS_SERVING_ENDPOINT=<endpoint-name>
export DATABRICKS_BUNDLE_TARGET=dev

mkdir -p /secure/local/lineage-guard-evidence
chmod 0700 /secure/local/lineage-guard-evidence

uv run python -m lineage_guard assess \
  --base <base-sha> \
  --head <head-sha> \
  --target "$DATABRICKS_BUNDLE_TARGET" \
  --output assessment.json \
  --markdown-output assessment.md \
  --restricted-evidence-dir /secure/local/lineage-guard-evidence
```

The command exits `0` for pass/warn, `1` for a grounded block, and `2` when the assessment cannot
be performed safely or discovery is incomplete. `assessment.json` and `assessment.md` are safe
public projections; detailed evidence is stored separately under its opaque reference. Local runs
use the selected CLI profile or another local Databricks authentication method. `github-oidc` works
only inside the configured GitHub Actions environment.

See [docs/oidc-setup.md](docs/oidc-setup.md) for the administrator checkpoint.

The deployed demo in workspace `7474650525906616` uses pipeline
`af63282c-f470-4770-97b5-bab16c8c7113` and SQL warehouse `4604ceea74f29ea8`.
Resource IDs remain stable across normal bundle updates but should be checked
with `databricks bundle summary` after a destructive redeployment.
