# GitHub OIDC administrator checkpoint

Complete this checkpoint after the baseline bundle is deployed and before opening the deliberately
breaking PR. It uses GitHub workload identity federation and stores no Databricks secret. Commands
below assume authenticated `gh`, workspace profile `proactive-zero-ops`, and an account-admin
Databricks CLI profile named `<account-admin-profile>`.

## 1. Create the GitHub environment

Create an environment named `lineage-guard` in `db-afeng/proactive-zero-ops`. Do not add deployment
reviewers: the required PR check must be automatic.

```bash
gh auth login --hostname github.com
gh api --method PUT repos/db-afeng/proactive-zero-ops/environments/lineage-guard
```

Add these environment variables:

| Variable | Value |
| --- | --- |
| `DATABRICKS_HOST` | `https://fevm-proactive-zero-ops.cloud.databricks.com` |
| `DATABRICKS_CLIENT_ID` | Application ID of the CI service principal |
| `DATABRICKS_WAREHOUSE_ID` | `a812711ddc3964b1` |
| `DATABRICKS_SERVING_ENDPOINT` | Pinned compatible Foundation Model endpoint |

## 2. Create the Databricks identity and federation policy

Create a service principal named `proactive-zero-ops-lineage-guard`, assign it to workspace
`7474647284745383`, then create the account-level federation policy. Record the returned numeric
`id` as `<service-principal-id>` and `applicationId` as `<service-principal-application-id>`.

```bash
databricks account service-principals create \
  --display-name proactive-zero-ops-lineage-guard \
  --active \
  --profile <account-admin-profile>

databricks account workspace-assignment update \
  7474647284745383 \
  <service-principal-id> \
  --json '{"permissions":["USER"]}' \
  --profile <account-admin-profile>

databricks account service-principal-federation-policy create \
  <service-principal-id> \
  --policy-id github-lineage-guard \
  --json '{
    "oidc_policy": {
      "issuer": "https://token.actions.githubusercontent.com",
      "audiences": ["https://github.com/db-afeng"],
      "subject": "repo:db-afeng/proactive-zero-ops:environment:lineage-guard"
    }
  }' \
  --profile <account-admin-profile>
```

The federation policy body is exactly:

```json
{
  "oidc_policy": {
    "issuer": "https://token.actions.githubusercontent.com",
    "audiences": ["https://github.com/db-afeng"],
    "subject": "repo:db-afeng/proactive-zero-ops:environment:lineage-guard"
  }
}
```

The numeric service-principal ID owns the policy; `DATABRICKS_CLIENT_ID` must contain its
application ID, not that numeric ID.

## 3. Grant least privilege

Grant the principal `CAN_USE` on only the bundle-created SQL warehouse:

```bash
databricks permissions update warehouses a812711ddc3964b1 \
  --json '{
    "access_control_list": [{
      "service_principal_name": "<service-principal-application-id>",
      "permission_level": "CAN_USE"
    }]
  }' \
  --profile proactive-zero-ops
```

As a metastore administrator, grant read access to only the two lineage tables:

```sql
GRANT USE CATALOG ON CATALOG system TO `<service-principal-application-id>`;
GRANT USE SCHEMA ON SCHEMA system.access TO `<service-principal-application-id>`;
GRANT SELECT ON TABLE system.access.column_lineage TO `<service-principal-application-id>`;
GRANT SELECT ON TABLE system.access.table_lineage TO `<service-principal-application-id>`;
```

The guard does not need `SELECT` on the credit-risk tables because it reads transformation source
from Git and relationship metadata from the system tables.

## 4. Select and verify the model endpoint

With an authenticated administrator profile, list compatible endpoints and smoke-test structured
output:

```bash
uv run python -m lineage_guard discover-endpoint --profile proactive-zero-ops
```

Store the returned endpoint name in `DATABRICKS_SERVING_ENDPOINT`, grant `CAN_QUERY`, and rerun the
command using the service principal/OIDC environment if desired. Resolve the endpoint ID and grant
query permission:

```bash
databricks serving-endpoints get <endpoint-name> \
  --profile proactive-zero-ops \
  --output json

databricks serving-endpoints update-permissions <endpoint-id-from-get> \
  --json '{
    "access_control_list": [{
      "service_principal_name": "<service-principal-application-id>",
      "permission_level": "CAN_QUERY"
    }]
  }' \
  --profile proactive-zero-ops
```

Set the GitHub environment variables:

```bash
gh variable set DATABRICKS_HOST \
  --env lineage-guard \
  --body https://fevm-proactive-zero-ops.cloud.databricks.com
gh variable set DATABRICKS_CLIENT_ID \
  --env lineage-guard \
  --body <service-principal-application-id>
gh variable set DATABRICKS_WAREHOUSE_ID \
  --env lineage-guard \
  --body a812711ddc3964b1
gh variable set DATABRICKS_SERVING_ENDPOINT \
  --env lineage-guard \
  --body <endpoint-name>
```

## 5. Verify federation and branch protection

The workflow sets `DATABRICKS_AUTH_TYPE=github-oidc`, requests `id-token: write`, and references the
`lineage-guard` environment, so its OIDC subject must match the policy above. After the first PR run
has registered the check name, create this `main` ruleset once:

```bash
gh api --method POST repos/db-afeng/proactive-zero-ops/rulesets --input - <<'JSON'
{
  "name": "main-lineage-guard",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/main"],
      "exclude": []
    }
  },
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "required_status_checks": [{"context": "downstream-impact"}],
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false
      }
    }
  ]
}
JSON
```

Authentication, lineage, or model failures intentionally fail the check closed.

In the first workflow log, verify that `DATABRICKS_AUTH_TYPE` is `github-oidc` and that no
`DATABRICKS_TOKEN` or client secret is configured. A successful lineage query and model call prove
federation end to end.
