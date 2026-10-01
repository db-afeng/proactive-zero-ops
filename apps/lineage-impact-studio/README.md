# Lineage Impact Studio

Lineage Impact Studio is an AppKit/React Databricks App for reviewing restricted
lineage assessments from pull requests. A workspace user follows an opaque
assessment link, sees only Unity Catalog evidence authorized for their
Databricks identity, and can review and approve one guarded remediation commit.

## Authorization boundary

- The app service principal reads immutable assessment envelopes from the
  restricted Unity Catalog Volume. The Volume grant is read-only.
- Disclosure checks use batched, parameterized, zero-row `IDENTIFIER` probes
  with the signed-in user's forwarded token and the `sql` OBO scope. Missing,
  denied, timed-out, over-budget, or otherwise unresolved checks fail closed;
  they never fall back to the service principal or scan `information_schema`.
- The live usage route reads a 30-day window of `system.access.table_lineage`
  with the app service principal, constrained to this workspace and the
  assessment paths already authorized for the viewer. A named query,
  dashboard, Genie space, notebook, pipeline, job, or alert contributes to a
  visible count only after its own OBO access check succeeds. Anonymous SQL
  runs are not named consumers; unresolved access checks make the count a
  labelled lower bound rather than a false zero.
- App OBO consent can lag a scope change. The viewer must complete a fresh
  Databricks app authorization when a new declared scope is deployed.
  Lakeview dashboard permission checks accept a dashboard UUID but return its
  numeric workspace object ID; the app verifies that response and an explicit
  viewer ACL entry before counting the dashboard. Job and pipeline permission
  checks require `access-management` under the viewer's OBO token, but
  Databricks Apps does not support that user scope. Its default
  `iam.access-control:read` scope does not authorize this permissions API.
  Until Apps supports a viewer-scoped permission check for these objects, they
  remain omitted and the count remains a labelled lower bound. Never
  substitute the app service principal for a viewer check.
- `files.files` is intentionally not an OBO scope. Generic AppKit Files routes
  must remain denied; the service reads only validated envelope paths.
- Restricted envelope v3 publishes deterministic `display_evidence` alongside
  the full server-only record. Browser responses use the redacted,
  allowlisted `AssessmentViewV3` contract; legacy v2 records return only a
  rerun-required state. Raw model prose and exact SQL must not enter the normal
  browser payload, HTML, telemetry, or logs.
- Exact expressions use `GET /api/assessments/:reference/source-evidence` and
  are returned only after the same Unity Catalog OBO authorization plus
  connected-user GitHub repository read access and exact PR base/head SHA
  validation.
- Fix tab retries register the connected user's GitHub token as a temporary
  credential owned by the app service principal. The managed session runs as
  that same principal; the credential ID is retained in Lakebase until the
  session finishes and is then removed. A cleanup sweep cancels abandoned
  sessions and retries credential removal after restarts. Automatic CI execution
  stays bound to the forwarded CI identity: the
  trusted workflow registers its GitHub token as a short-lived Databricks Git
  credential, passes only that credential's ID to Omnigent, and deletes the
  credential when the proposal finishes. It never falls back to a different
  identity that cannot resolve that credential. Managed sessions use the
  `codex-native-ui` agent by default; `OMNIGENT_AGENT_NAME` can select another
  installed agent explicitly. The deployed app pins managed sessions to
  `gpt-5.6-terra` through `OMNIGENT_MODEL_OVERRIDE` before dispatching the
  fix prompt, so Omnigent does not fall back to its 5.2 default.
- Omnigent must be able to clone the private repository as the identity that
  owns the managed session. Fix tab retries provision that access from the
  connected GitHub account, and CI sessions provision it from the workflow token.
- Lakebase stores OAuth state, encrypted GitHub tokens, fix sessions, encrypted
  patches, approvals, and append-only commit audit records. The app service
  principal must create and own the `lineage_impact` schema.

## Configured Databricks resources

| Resource          | Configuration                                                                         |
| ----------------- | ------------------------------------------------------------------------------------- |
| Workspace/profile | `fe-sandbox-proactive-zero-ops`                                                       |
| App               | `lineage-impact-studio`                                                               |
| SQL warehouse     | `4604ceea74f29ea8` (`proactive-zero-ops-lineage-guard`)                               |
| Restricted Volume | `/Volumes/proactive_zero_ops_catalog/proactive_zero_ops_guard/restricted_assessments` |
| Volume permission | `READ_VOLUME` for the app service principal                                           |
| Lakebase project  | `projects/lineage-impact-studio`                                                      |
| Lakebase branch   | `projects/lineage-impact-studio/branches/production`                                  |
| Lakebase database | `projects/lineage-impact-studio/branches/production/databases/databricks-postgres`    |
| App-owned schema  | `lineage_impact`                                                                      |
| Lineage table     | `system.access.table_lineage` with app service-principal `SELECT`                     |
| OBO scopes        | `sql`, `genie`, `workspace.workspace:read`                                            |

`app.yaml` receives the warehouse, Volume, Lakebase endpoint, and encryption
key through `valueFrom` resource bindings. Databricks also injects the deployed
Lakebase `PG*` variables. Bundle variables are not
interpolated inside `app.yaml`, so do not add `${var.*}` placeholders there.

## Required secrets and environment

The target declares three read-only keys in the `lineage-impact-studio`
Databricks secret scope:

| Secret key             | Runtime environment variable    | Requirement                                          |
| ---------------------- | ------------------------------- | ---------------------------------------------------- |
| `encryption-key`       | `LINEAGE_IMPACT_ENCRYPTION_KEY` | Canonical base64 encoding of exactly 32 random bytes |
| `github-client-id`     | `GITHUB_CLIENT_ID`              | Client ID of the repository-restricted GitHub App    |
| `github-client-secret` | `GITHUB_CLIENT_SECRET`          | Active client secret of that GitHub App              |

The scope and key must exist before deployment. The deployment operator
must be allowed to grant the app service principal `READ` on the scope. Never
put the secret value in source control, bundle variables, logs, or command
arguments.

The canonical callback is configured directly in `app.yaml` as:

```text
https://lineage-impact-studio-7474650525906616.aws.databricksapps.com/api/github/oauth/callback
```

The client ID and client secret are injected through `valueFrom` bindings. Never
put either value in source control, bundle variables, logs, or command arguments.
The server must refuse GitHub OAuth when any required value is absent.

For local checks, copy `.env.example` to `.env`, populate local-only secret
values, and keep `.env` untracked. Use Node.js 22.18 or newer. Do not initialize
the `lineage_impact` schema with a developer identity: after deployment is
explicitly approved, the deployed app must start first so its service principal
creates and owns the schema.

## GitHub App contract

Create a GitHub App installed only on `db-afeng/proactive-zero-ops` with these
repository permissions:

- Metadata: read (implicit)
- Pull requests: read
- Contents: read and write

Use user-to-server OAuth with PKCE and this callback path:
`/api/github/oauth/callback`. The acting identity comes from authenticated
`GET /user`; no organization, email, administration, or webhook permissions
are required. The app rejects forks and revalidates repository, PR state,
write access, and exact head SHA before creating a normal commit. Read-only
source evidence uses a separate gate which requires pull access and matching
assessed base/head SHAs but does not require push access.

## Release blockers

Deployment is blocked until all of the following are resolved:

1. Workspace user authorization remains enabled and intended reviewers receive
   `CAN_USE` on SQL warehouse `4604ceea74f29ea8`. The resource declaration
   grants the app service principal access, but OBO queries require the user to
   have warehouse access independently.
2. Create the `lineage-impact-studio` secret scope and provision its declared
   encryption key.
3. Register and restrict the GitHub App, then configure its real client ID,
   client secret, and canonical OAuth redirect URI.
4. Validate managed session creation, polling, cancellation, and diff retrieval
   from the deployed app runtime. Fix tab retries create and remove an app-owned
   Git credential. Automatic CI sessions create and delete a caller-owned
   short-lived credential and must fail closed instead of falling back to the
   app service principal.
5. Make every validation gate below green.
6. With a non-privileged test principal that has warehouse `CAN_USE` but no
   `SELECT` on a dedicated test table, execute the parameterized zero-row probe
   `SELECT 1 FROM IDENTIFIER(:asset) WHERE FALSE`. It must fail with an access
   error. A successful empty result is a deployment blocker.

## Validation

Run from this directory with the selected profile:

```bash
npm test
npm run typecheck
npm run lint
npm run lint:ast-grep
npm run format
npm run build
npm run typegen
npm --prefix tests ci
npm run test:e2e
git diff --check
DATABRICKS_AUTH_STORAGE=plaintext databricks bundle validate --strict --profile fe-sandbox-proactive-zero-ops
DATABRICKS_AUTH_STORAGE=plaintext databricks apps validate --profile fe-sandbox-proactive-zero-ops
```

Also require the Playwright graph, accessibility, visual-regression,
narrow/desktop layout, source-evidence, and stale commit flows to pass. The
manual Impeccable review is documented in `DESIGN.md`; Impeccable is not a
runtime dependency.

Every deployed app change also requires a production smoke test in the Codex
embedded browser before it can be merged to `main`. For dataset samples, select
both a changed node and an impacted node and confirm that:

- the sample is not requested before node selection;
- every visible header includes its exact deployed SQL type;
- the affected header and cells retain the Changed or Impacted badge and
  semantic highlight;
- five current rows render when available, and denied access exposes no sample
  values; and
- query history contains no `information_schema` scan.

The Playwright sample test is the automated regression gate for header types;
the embedded-browser check confirms the real deployed query contract and UI.
For live usage, verify distinct counts on the current assessment URL, grouped
direct and indirect consumers, same counts on duplicate table nodes, and a
Databricks link for each visible object. Check that a denied object never
contributes its name, link, or count, and that lineage or metadata failures
render a partial or unavailable state instead of zero.

Configuration validation succeeded on 2026-09-28. Full Apps validation reached
type checking and was not green at that point, so it is not a deployment
approval.

## Rollout

Deploy through the root bundle, verify the service principal owns
`lineage_impact`, test
full/partial/no-access OBO users and a disposable same-repository PR, then set
the workflow's canonical app URL. Enable deep links only for newly published
assessments; do not backfill historical v2 evidence. After the guard and app
are deployed together, close PR #4 and open a replacement from the same branch
to publish a v3 assessment and verify the complete causal chain before wider
rollout. Confirm the viewer's initial warehouse queries remain zero-row OBO
probes; the separately authorized usage lookup is a bounded app-principal
query of `system.access.table_lineage`. There must be no `information_schema`
scan, and dataset sample queries must run only after an authorized changed or
impacted node is selected.
