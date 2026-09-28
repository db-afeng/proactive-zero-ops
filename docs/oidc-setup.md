# GitHub OIDC administrator checkpoint

Complete this checkpoint after the baseline bundle is deployed and before opening the deliberately
breaking PR. It uses GitHub workload identity federation and stores no Databricks secret. Commands
below assume authenticated `gh`, workspace profile `fe-sandbox-proactive-zero-ops`, and the
account-admin Databricks CLI profile `fevm-aws`.

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
| `DATABRICKS_HOST` | `https://fe-sandbox-proactive-zero-ops.cloud.databricks.com` |
| `DATABRICKS_CLIENT_ID` | Application ID of the CI service principal |
| `DATABRICKS_WAREHOUSE_ID` | `4604ceea74f29ea8` |
| `DATABRICKS_SERVING_ENDPOINT` | `databricks-gpt-5-6-terra` (current compatible endpoint) |
| `DATABRICKS_BUNDLE_TARGET` | `dev` |
| `LINEAGE_GUARD_RESTRICTED_VOLUME_ROOT` | `/Volumes/proactive_zero_ops_catalog/proactive_zero_ops_guard/restricted_assessments` |
| `LINEAGE_IMPACT_STUDIO_URL` | Deployed HTTPS URL of the `lineage-impact-studio` Databricks App |

The bundle target is selected by this trusted environment variable (the workflow has a trusted
`dev` default). Pull-request configuration cannot select a different target or connection. The
checker reads both revisions as data and does not validate, plan, deploy, or run the proposed bundle.
Executable bundle generators and unresolved dynamic configuration are reported as unsupported.

## 2. Create the Databricks identity and federation policy

Create a service principal named `proactive-zero-ops-lineage-guard`, assign it to workspace
`7474650525906616`, then create the account-level federation policy. Record the returned numeric
`id` as `<service-principal-id>` and `applicationId` as `<service-principal-application-id>`.

```bash
databricks account service-principals create \
  --display-name proactive-zero-ops-lineage-guard \
  --active \
  --profile fevm-aws

databricks account workspace-assignment update \
  7474650525906616 \
  <service-principal-id> \
  --json '{"permissions":["USER"]}' \
  --profile fevm-aws

databricks account service-principal-federation-policy create \
  <service-principal-id> \
  --policy-id github-lineage-guard \
  --json '{
    "oidc_policy": {
      "issuer": "https://token.actions.githubusercontent.com",
      "audiences": ["https://fe-sandbox-proactive-zero-ops.cloud.databricks.com/oidc/v1/token"],
      "subject": "repo:db-afeng@197553067/proactive-zero-ops@1384523601:environment:lineage-guard"
    }
  }' \
  --profile fevm-aws
```

The federation policy body is exactly:

```json
{
  "oidc_policy": {
    "issuer": "https://token.actions.githubusercontent.com",
    "audiences": ["https://fe-sandbox-proactive-zero-ops.cloud.databricks.com/oidc/v1/token"],
    "subject": "repo:db-afeng@197553067/proactive-zero-ops@1384523601:environment:lineage-guard"
  }
}
```

This repository has GitHub immutable OIDC subjects enabled. Verify the current IDs and subject
prefix before creating or replacing the policy:

```bash
gh api repos/db-afeng/proactive-zero-ops/actions/oidc/customization/sub
gh api repos/db-afeng/proactive-zero-ops \
  --jq '{repository_id: .id, owner_id: .owner.id}'
```

The expected response includes `"use_immutable_subject": true`, owner ID `197553067`, repository
ID `1384523601`, and subject prefix
`repo:db-afeng@197553067/proactive-zero-ops@1384523601`. A mutable repository-name subject or the
GitHub organization URL as audience fails federation with `TOKEN_SUBJECT_INVALID`.

The numeric service-principal ID owns the policy; `DATABRICKS_CLIENT_ID` must contain its
application ID, not that numeric ID.

## 3. Grant least privilege

Grant the workspace service principal the SQL access entitlement required by the Statement
Execution API:

```bash
databricks service-principals patch <service-principal-id> \
  --json '{
    "schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    "Operations":[{
      "op":"add",
      "path":"entitlements",
      "value":[{"value":"databricks-sql-access"}]
    }]
  }' \
  --profile fe-sandbox-proactive-zero-ops
```

Grant the principal `CAN_USE` on only the bundle-created SQL warehouse:

```bash
databricks permissions update warehouses 4604ceea74f29ea8 \
  --json '{
    "access_control_list": [{
      "service_principal_name": "<service-principal-application-id>",
      "permission_level": "CAN_USE"
    }]
  }' \
  --profile fe-sandbox-proactive-zero-ops
```

As a metastore administrator, grant read access to only the two lineage tables:

```sql
GRANT USE CATALOG ON CATALOG system TO `<service-principal-application-id>`;
GRANT USE SCHEMA ON SCHEMA system.access TO `<service-principal-application-id>`;
GRANT SELECT ON TABLE system.access.column_lineage TO `<service-principal-application-id>`;
GRANT SELECT ON TABLE system.access.table_lineage TO `<service-principal-application-id>`;
```

The bundle creates the managed `restricted_assessments` Volume. Grant the CI principal only the
parent traversal and file privileges needed for immutable publication and idempotent retry checks:

```sql
GRANT USE CATALOG ON CATALOG proactive_zero_ops_catalog
TO `<service-principal-application-id>`;
GRANT USE SCHEMA ON SCHEMA proactive_zero_ops_catalog.proactive_zero_ops_guard
TO `<service-principal-application-id>`;
GRANT READ VOLUME, WRITE VOLUME ON VOLUME
  proactive_zero_ops_catalog.proactive_zero_ops_guard.restricted_assessments
TO `<service-principal-application-id>`;
```

Grant `READ VOLUME` (with parent `USE` privileges) separately to the Databricks App service
principal. Do not grant Volume access to workspace users: the app reads the envelope as its service
principal and performs the asset-level disclosure checks with the signed-in user's OBO identity.

The guard does not need `SELECT` on the credit-risk tables because it reads transformation source
from Git and relationship metadata from the system tables.

## 4. Select and verify the model endpoint

With an authenticated administrator profile, list compatible endpoints and smoke-test structured
output:

```bash
uv run python -m lineage_guard discover-endpoint --profile fe-sandbox-proactive-zero-ops
```

If discovery reports that no `system.ai` Claude Sonnet endpoint is available, have a workspace
administrator enable a compatible Claude Sonnet Foundation Model API endpoint and rerun discovery.
The current workspace has no Claude Sonnet endpoint, so `databricks-gpt-5-6-terra` is pinned as the
tested fallback. It passes the same strict structured-output request used by the guard. Re-run the
discovery command and replace this fallback when Claude Sonnet becomes available.

Store the returned endpoint name in `DATABRICKS_SERVING_ENDPOINT`. The pinned fallback is exposed
as a `system.ai` function, so grant `EXECUTE` only on that function:

```sql
GRANT EXECUTE ON FUNCTION system.ai.`databricks-gpt-5-6-terra`
TO `<service-principal-application-id>`;
```

If a future Claude model is exposed as a serving endpoint instead of a `system.ai` function,
resolve its endpoint ID and grant `CAN_QUERY`:

```bash
databricks serving-endpoints get <endpoint-name> \
  --profile fe-sandbox-proactive-zero-ops \
  --output json

databricks serving-endpoints update-permissions <endpoint-id-from-get> \
  --json '{
    "access_control_list": [{
      "service_principal_name": "<service-principal-application-id>",
      "permission_level": "CAN_QUERY"
    }]
  }' \
  --profile fe-sandbox-proactive-zero-ops
```

Set the GitHub environment variables:

```bash
gh variable set DATABRICKS_HOST \
  --env lineage-guard \
  --body https://fe-sandbox-proactive-zero-ops.cloud.databricks.com
gh variable set DATABRICKS_CLIENT_ID \
  --env lineage-guard \
  --body <service-principal-application-id>
gh variable set DATABRICKS_WAREHOUSE_ID \
  --env lineage-guard \
  --body 4604ceea74f29ea8
gh variable set DATABRICKS_SERVING_ENDPOINT \
  --env lineage-guard \
  --body <endpoint-name>
gh variable set DATABRICKS_BUNDLE_TARGET \
  --env lineage-guard \
  --body dev
gh variable set LINEAGE_GUARD_RESTRICTED_VOLUME_ROOT \
  --env lineage-guard \
  --body /Volumes/proactive_zero_ops_catalog/proactive_zero_ops_guard/restricted_assessments
gh variable set LINEAGE_IMPACT_STUDIO_URL \
  --env lineage-guard \
  --body <deployed-app-https-url>
```

## 5. Understand the identity and evidence boundary

`DATABRICKS_AUTH_TYPE=github-oidc` exchanges the workflow's GitHub token for the CI **service
principal**. It is workload identity federation, not on-behalf-of (OBO) authentication and not user
delegation. Databricks sees the service principal's grants when the guard queries lineage and calls
the model.

Checking the PR author's Databricks permissions would not make a GitHub report private: comments,
summaries, logs, and artifacts can be read by other repository users. The workflow therefore
publishes only an approved outcome, generic message, and random opaque assessment reference on
every GitHub surface. It never publishes SQL, source paths, asset IDs, owners, lineage paths,
downstream definitions, model text, or detailed errors.

Full evidence is atomically staged under `$RUNNER_TEMP/lineage-guard-restricted` with directory mode
`0700` and file mode `0600`, then published as the immutable
`<assessment-reference>.json` object in the restricted Unity Catalog Volume. The local directory and
checker logs are never uploaded as GitHub artifacts. A retry accepts an existing object only when
its bytes are identical; the workflow never overwrites evidence bound to an opaque reference.

The pull-request comment receives an app deep link only after Volume publication succeeds and the
published reference still matches the strict public artifact. The GitHub OIDC identity is still the
CI service principal, not the viewing user. Viewer-specific disclosure happens later in the app
through genuine Databricks OBO authorization.

## 6. Configure static runner egress when workspace IP ACLs are enabled

Do not add GitHub's complete hosted-runner address list to a Databricks workspace allowlist. GitHub
currently publishes thousands of dynamic Actions CIDRs, a rerun can move to a different range, and
Databricks supports at most 1,000 CIDR values across all access lists.

Use either a self-hosted runner whose NAT address is already approved or a GitHub larger runner with
static IP addresses. Add only that runner's narrow, stable egress CIDR in a separate Databricks
allowlist; never modify `fevm-managed-allowlist-DoNotModify`. Give the runner a dedicated label such
as `lineage-guard`, then set the repository variable consumed by the trusted workflow:

```bash
gh variable set LINEAGE_GUARD_RUNNER \
  --repo db-afeng/proactive-zero-ops \
  --body lineage-guard

gh api repos/db-afeng/proactive-zero-ops/actions/runners \
  --jq '.runners[] | {name, status, labels: [.labels[].name]}'
```

The second command must show an online runner carrying the configured label before the PR check is
rerun. If `LINEAGE_GUARD_RUNNER` is unset, the workflow falls back to `ubuntu-latest`, which is
suitable only when the target workspace does not restrict public egress with IP ACLs.

## 7. Verify federation and branch protection

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

Authentication, model, discovery, parsing, configuration, and lineage coverage failures
intentionally fail the check closed. Missing observed lineage is reported as incomplete coverage,
not as proof of no downstream impact.

In the first workflow log, verify that `DATABRICKS_AUTH_TYPE` is `github-oidc` and that no
`DATABRICKS_TOKEN` or client secret is configured. A successful lineage query and model call prove
service-principal federation end to end; they do not prove user delegation.
