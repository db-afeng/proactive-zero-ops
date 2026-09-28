# Lineage Impact Studio

Lineage Impact Studio is an AppKit/React Databricks App for reviewing restricted
lineage assessments from pull requests. A workspace user follows an opaque
assessment link, sees only Unity Catalog evidence authorized for their
Databricks identity, and can review and approve one guarded remediation commit.

## Authorization boundary

- The app service principal reads immutable assessment envelopes from the
  restricted Unity Catalog Volume. The Volume grant is read-only.
- Disclosure checks run against `system.information_schema` with the signed-in
  user's forwarded token and the `sql` OBO scope. Missing or failed OBO
  authentication must fail closed; it must never fall back to the service
  principal.
- `files.files` is intentionally not an OBO scope. Generic AppKit Files routes
  must remain denied; the service reads only validated envelope paths.
- Browser responses use the redacted `AssessmentViewV1` contract. Raw evidence
  must not enter browser payloads, HTML, telemetry, or logs.
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
| OBO scopes        | `sql` only                                                                            |

`app.yaml` receives the warehouse, Volume, Lakebase endpoint, and encryption
key through `valueFrom` resource bindings. Databricks also injects the deployed
Lakebase `PG*` variables. Bundle variables are not
interpolated inside `app.yaml`, so do not add `${var.*}` placeholders there.

## Required secrets and environment

The target declares one read-only key in the `lineage-impact-studio`
Databricks secret scope:

| Secret key       | Runtime environment variable    | Requirement                                          |
| ---------------- | ------------------------------- | ---------------------------------------------------- |
| `encryption-key` | `LINEAGE_IMPACT_ENCRYPTION_KEY` | Canonical base64 encoding of exactly 32 random bytes |

The scope and key must exist before deployment. The deployment operator
must be allowed to grant the app service principal `READ` on the scope. Never
put the secret value in source control, bundle variables, logs, or command
arguments.

GitHub OAuth values remain required after GitHub App registration and after
the canonical Databricks App URL is known:

```env
GITHUB_CLIENT_ID=<github-app-client-id>
GITHUB_CLIENT_SECRET=<github-app-client-secret>
GITHUB_REDIRECT_URI=https://<deployed-app-host>/api/github/oauth/callback
```

Add them as literal `value` entries in `app.yaml` only when the real values are
known. The server must refuse GitHub OAuth when any required value is absent.

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
write access, and exact head SHA before creating a normal commit.

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
4. Confirm Omnigent has a supported workspace API. Fix generation remains
   disabled and fail-closed if no programmable API is available.
5. Make every validation gate below green.

## Validation

Run from this directory with the selected profile:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run typegen
npm --prefix tests ci
npm run test:e2e
git diff --check
DATABRICKS_AUTH_STORAGE=plaintext databricks bundle validate --strict --profile fe-sandbox-proactive-zero-ops
DATABRICKS_AUTH_STORAGE=plaintext databricks apps validate --profile fe-sandbox-proactive-zero-ops
```

Also require the Playwright, accessibility, narrow/desktop layout, and stale
commit flows to pass. The project-local Impeccable installer is blocked by the
configured private npm proxy, so the fallback review is documented in
`DESIGN.md` against the Slop catalog.

Configuration validation succeeded on 2026-09-28. Full Apps validation reached
type checking and was not green at that point, so it is not a deployment
approval.

## Rollout

Deploy through the root bundle, verify the service principal owns
`lineage_impact`, test
full/partial/no-access OBO users and a disposable same-repository PR, then set
the workflow's canonical app URL. Enable deep links only for newly published
assessments; do not backfill runner-local historical evidence.
