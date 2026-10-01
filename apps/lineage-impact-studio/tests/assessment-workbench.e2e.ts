import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const REFERENCE = 'assessment_K4z7pq2X';
const LOAN_EXPOSURE_ASSET = 'proactive_zero_ops_catalog.proactive_zero_ops_silver.loan_exposure';
const HEAD_SHA = 'f1e2d3c4b5a697887766554433221100ffeeddcc';
const PATCH_DIGEST = 'sha256:996a18d9270f53766792eb17edcf73d5540fe9dc56820cb5de161e1151c71dc8';
const PROPOSAL_SHA = '1234567890abcdef1234567890abcdef12345678';

const assessment = {
  schemaVersion: 3,
  reference: REFERENCE,
  detailState: 'available',
  status: 'block',
  severity: 'high',
  message: 'A potentially breaking downstream impact was identified.',
  headline: 'outstanding_balance is now text, but loan_exposure still performs numeric arithmetic.',
  recommendedAction:
    'Keep the source column numeric and add currency formatting in a separate presentation column or layer.',
  rawModelProse: 'Never render arbitrary model analysis.',
  source: {
    provider: 'github',
    createdAt: '2026-09-28T09:32:00+10:00',
    freshness: 'current',
    evidenceOrigin: 'mixed',
  },
  pullRequest: {
    repository: 'db-afeng/proactive-zero-ops',
    number: 4,
    baseSha: '89b8dcf7315c3f84698a3f35a59b0c017ac148d3',
    headSha: HEAD_SHA,
  },
  viewer: {
    subject: 'user:workspace-viewer',
    displayName: 'Workspace Viewer',
  },
  confidence: {
    interpretation: 0.95,
    discovery: 'complete',
  },
  changes: [
    {
      id: 'change-1',
      asset: 'proactive_zero_ops_catalog.proactive_zero_ops_bronze.loan_accounts',
      column: 'outstanding_balance',
      changeKind: 'modified',
      beforeType: 'numeric',
      afterType: 'text',
    },
  ],
  impacts: [
    {
      id: 'impact-1',
      changeId: 'change-1',
      relation: 'direct',
      targetAsset: 'proactive_zero_ops_catalog.proactive_zero_ops_bronze.loan_accounts',
      targetColumn: 'non_negative_balance',
      operation: 'constraint',
      reason: 'incompatible_type',
      evidenceLevel: 'definition',
      path: [
        {
          kind: 'asset',
          reference: 'proactive_zero_ops_catalog.proactive_zero_ops_bronze.loan_accounts',
          assetType: 'table',
        },
      ],
      remediation: 'restore_contract',
    },
    {
      id: 'impact-2',
      changeId: 'change-1',
      relation: 'direct',
      targetAsset: 'proactive_zero_ops_catalog.proactive_zero_ops_silver.loan_exposure',
      targetColumn: 'effective_ead',
      operation: 'arithmetic',
      reason: 'incompatible_type',
      evidenceLevel: 'definition',
      path: [
        {
          kind: 'asset',
          reference: 'proactive_zero_ops_catalog.proactive_zero_ops_bronze.loan_accounts',
          assetType: 'table',
        },
        {
          kind: 'asset',
          reference: 'proactive_zero_ops_catalog.proactive_zero_ops_silver.loan_exposure',
          assetType: 'view',
        },
      ],
      remediation: 'restore_contract',
    },
    {
      id: 'impact-3',
      changeId: 'change-1',
      relation: 'direct',
      targetAsset: 'proactive_zero_ops_catalog.proactive_zero_ops_silver.loan_exposure',
      targetColumn: 'utilization_ratio',
      operation: 'arithmetic',
      reason: 'incompatible_type',
      evidenceLevel: 'definition',
      path: [
        {
          kind: 'asset',
          reference: 'proactive_zero_ops_catalog.proactive_zero_ops_bronze.loan_accounts',
          assetType: 'table',
        },
        {
          kind: 'asset',
          reference: 'proactive_zero_ops_catalog.proactive_zero_ops_silver.loan_exposure',
          assetType: 'view',
        },
      ],
      remediation: 'restore_contract',
    },
    {
      id: 'impact-4',
      changeId: 'change-1',
      relation: 'transitive',
      targetAsset: 'proactive_zero_ops_catalog.proactive_zero_ops_gold.portfolio_expected_loss',
      targetColumn: null,
      operation: 'unknown',
      reason: 'upstream_failure',
      evidenceLevel: 'lineage',
      path: [
        {
          kind: 'asset',
          reference: 'proactive_zero_ops_catalog.proactive_zero_ops_bronze.loan_accounts',
          assetType: 'table',
        },
        { kind: 'restricted' },
        {
          kind: 'asset',
          reference: 'proactive_zero_ops_catalog.proactive_zero_ops_gold.portfolio_expected_loss',
          assetType: 'materialized_view',
        },
      ],
      remediation: 'restore_contract',
    },
  ],
  graph: {
    nodes: [
      {
        id: 'change-change-1',
        role: 'changed',
        label: 'loan_accounts.outstanding_balance',
        asset: 'proactive_zero_ops_catalog.proactive_zero_ops_bronze.loan_accounts',
        assetType: 'table',
        column: 'outstanding_balance',
        changeId: 'change-1',
      },
      impactNode('impact-1', 'loan_accounts.non_negative_balance', 'direct_break'),
      impactNode('impact-2', 'loan_exposure.effective_ead', 'direct_break'),
      impactNode('impact-3', 'loan_exposure.utilization_ratio', 'direct_break'),
      impactNode('impact-4', 'portfolio_expected_loss', 'transitive_impact'),
      {
        id: 'restricted',
        role: 'restricted',
        label: 'Restricted lineage',
        asset: 'secret.hidden.customer_pii',
        column: 'secret_balance',
        count: 47,
      },
    ],
    edges: [
      graphEdge('edge-1', 'change-change-1', 'impact-impact-1', 'proposed_code', 'definition'),
      graphEdge('edge-2', 'change-change-1', 'impact-impact-2', 'observed_lineage', 'column'),
      graphEdge('edge-3', 'change-change-1', 'impact-impact-3', 'proposed_code', 'column'),
      graphEdge('edge-4', 'restricted', 'impact-impact-4', 'observed_lineage', 'table'),
    ],
  },
  disclosure: {
    state: 'partial',
    notice: 'Some lineage is hidden because you do not have access.',
  },
};

const usage = {
  schemaVersion: 1,
  assessmentReference: REFERENCE,
  observedFrom: '2026-09-01T00:00:00Z',
  observedThrough: '2026-09-30T23:59:59Z',
  assets: [
    {
      asset: 'proactive_zero_ops_catalog.proactive_zero_ops_bronze.loan_accounts',
      count: 0,
      directCount: 0,
      indirectCount: 0,
      byType: { query: 0, dashboard: 0, genie: 0, notebook: 0, pipeline: 0, job: 0, alert: 0 },
      complete: true,
      objects: [],
    },
    {
      asset: 'proactive_zero_ops_catalog.proactive_zero_ops_silver.loan_exposure',
      count: 5,
      directCount: 3,
      indirectCount: 2,
      byType: { query: 1, dashboard: 1, genie: 1, notebook: 1, pipeline: 1, job: 0, alert: 0 },
      complete: true,
      objects: [
        {
          kind: 'query',
          title: 'Exposure watch query',
          url: 'https://dbc-example.cloud.databricks.com/sql/queries/exposure-watch',
          relation: 'direct',
          viaAssets: [],
          accessMode: 'read',
          lastObservedAt: '2026-09-30T12:00:00Z',
        },
        {
          kind: 'dashboard',
          title: 'Credit exposure dashboard',
          url: 'https://dbc-example.cloud.databricks.com/sql/dashboards/credit-exposure',
          relation: 'direct',
          viaAssets: [],
          accessMode: 'read',
          lastObservedAt: '2026-09-29T12:00:00Z',
        },
        {
          kind: 'genie',
          title: 'Loan analysis room',
          url: 'https://dbc-example.cloud.databricks.com/genie/rooms/loan-analysis',
          relation: 'direct',
          viaAssets: [],
          accessMode: 'read',
          lastObservedAt: '2026-09-28T12:00:00Z',
        },
        {
          kind: 'notebook',
          title: 'Portfolio risk notebook',
          url: 'https://dbc-example.cloud.databricks.com/editor/notebooks/portfolio-risk',
          relation: 'indirect',
          viaAssets: ['proactive_zero_ops_catalog.proactive_zero_ops_gold.portfolio_expected_loss'],
          accessMode: 'read',
          lastObservedAt: '2026-09-27T12:00:00Z',
        },
        {
          kind: 'pipeline',
          title: 'Expected loss refresh',
          url: 'https://dbc-example.cloud.databricks.com/pipelines/expected-loss-refresh',
          relation: 'indirect',
          viaAssets: ['proactive_zero_ops_catalog.proactive_zero_ops_gold.portfolio_expected_loss'],
          accessMode: 'read_write',
          lastObservedAt: '2026-09-26T12:00:00Z',
        },
      ],
    },
    {
      asset: 'proactive_zero_ops_catalog.proactive_zero_ops_gold.portfolio_expected_loss',
      count: 2,
      directCount: 2,
      indirectCount: 0,
      byType: { query: 1, dashboard: 1, genie: 0, notebook: 0, pipeline: 0, job: 0, alert: 0 },
      complete: true,
      objects: [
        {
          kind: 'query',
          title: 'Loss trend query',
          url: 'https://dbc-example.cloud.databricks.com/sql/queries/loss-trend',
          relation: 'direct',
          viaAssets: [],
          accessMode: 'read',
          lastObservedAt: '2026-09-30T12:00:00Z',
        },
        {
          kind: 'dashboard',
          title: 'Portfolio loss dashboard',
          url: 'https://dbc-example.cloud.databricks.com/sql/dashboards/portfolio-loss',
          relation: 'direct',
          viaAssets: [],
          accessMode: 'read',
          lastObservedAt: '2026-09-29T12:00:00Z',
        },
      ],
    },
  ],
};

function impactNode(id: string, label: string, role: 'direct_break' | 'transitive_impact') {
  const asset =
    id === 'impact-1'
      ? 'proactive_zero_ops_catalog.proactive_zero_ops_bronze.loan_accounts'
      : id === 'impact-4'
        ? 'proactive_zero_ops_catalog.proactive_zero_ops_gold.portfolio_expected_loss'
        : 'proactive_zero_ops_catalog.proactive_zero_ops_silver.loan_exposure';
  return { id: `impact-${id}`, role, label, asset, impactId: id };
}

function graphEdge(
  id: string,
  source: string,
  target: string,
  origin: 'observed_lineage' | 'proposed_code',
  evidenceLevel: 'column' | 'table' | 'definition'
) {
  const sourceAsset = id === 'edge-4' ? null : 'proactive_zero_ops_catalog.proactive_zero_ops_bronze.loan_accounts';
  const targetAsset =
    id === 'edge-4'
      ? null
      : id === 'edge-1'
        ? sourceAsset
        : 'proactive_zero_ops_catalog.proactive_zero_ops_silver.loan_exposure';
  const targetColumn =
    id === 'edge-1'
      ? 'non_negative_balance'
      : id === 'edge-2'
        ? 'effective_ead'
        : id === 'edge-3'
          ? 'utilization_ratio'
          : null;
  return {
    id,
    source,
    target,
    origin,
    evidenceLevel,
    lastObservedAt: null,
    sourceAsset,
    sourceColumn: sourceAsset === null ? null : 'outstanding_balance',
    targetAsset,
    targetColumn,
  };
}

test.beforeEach(async ({ page }) => {
  await mockAssessmentApis(page);
});

test('explains the PR #4 break and keeps the default graph causal', async ({ page }) => {
  await page.goto(`/assessments/${REFERENCE}`);

  await expect(page).toHaveTitle('db-afeng/proactive-zero-ops #4 · Lineage Impact Studio');
  await expect(
    page.getByRole('heading', {
      name: 'outstanding_balance is now text, but loan_exposure still performs numeric arithmetic.',
    })
  ).toBeVisible();
  await expect(page.getByText('Some lineage is restricted', { exact: true })).toBeVisible();
  await expect(page.getByText('loan_exposure.effective_ead', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('loan_exposure.utilization_ratio', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('loan_accounts.non_negative_balance', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('delinquency_features', { exact: false })).toHaveCount(0);
  await expect(page.getByText('payment_events', { exact: false })).toHaveCount(0);
  await expect(page.getByText('borrower', { exact: false })).toHaveCount(0);
  await expect(page.getByText('secret.hidden.customer_pii', { exact: false })).toHaveCount(0);
  await expect(page.getByText('secret_balance', { exact: false })).toHaveCount(0);
  await expect(page.getByText('Never render arbitrary model analysis.', { exact: true })).toHaveCount(0);
  await expect(page.getByText(`Reference ${REFERENCE}`, { exact: true }).first()).toBeVisible();
});

test('shows table-level consumer counts and keeps duplicate impact nodes synchronized', async ({ page }) => {
  await page.goto(`/assessments/${REFERENCE}`);

  const graph = page.getByLabel('Impact lineage graph');
  await expect(graph.getByText(/visible objects observed in the last 30 days/)).toBeVisible();
  const effectiveNode = graph.locator('.impact-node-direct-break').filter({ hasText: 'loan_exposure.effective_ead' });
  const utilizationNode = graph
    .locator('.impact-node-direct-break')
    .filter({ hasText: 'loan_exposure.utilization_ratio' });
  await expect(effectiveNode.locator('span[title^="5 distinct observed consumers"]')).toHaveText('5');
  await expect(utilizationNode.locator('span[title^="5 distinct observed consumers"]')).toHaveText('5');
  await expect(
    graph
      .locator('.impact-node-transitive')
      .filter({ hasText: 'portfolio_expected_loss' })
      .locator('span[title^="2 distinct observed consumers"]')
  ).toHaveText('2');

  const table = page.getByRole('button', { name: `Show observed consumers of ${LOAN_EXPOSURE_ASSET}` });
  await expect(table).toContainText('5 consumers');
  await table.click();
  await expect(
    page.getByText('Counts include visible objects observed in the last 30 days, regardless of impact scope.')
  ).toBeVisible();
  const consumers = page.getByRole('group', { name: `Observed consumers of ${LOAN_EXPOSURE_ASSET}`, exact: true });
  const directLinks = consumers.getByRole('region', {
    name: `Direct consumers of ${LOAN_EXPOSURE_ASSET}`,
    exact: true,
  });
  const indirectLinks = consumers.getByRole('region', {
    name: `Indirect consumers of ${LOAN_EXPOSURE_ASSET}`,
    exact: true,
  });
  await expect(directLinks).toBeVisible();
  await expect(indirectLinks).toBeVisible();
  await expect(consumers.getByRole('link', { name: 'Open Query Exposure watch query in Databricks' })).toHaveAttribute(
    'href',
    'https://dbc-example.cloud.databricks.com/sql/queries/exposure-watch'
  );
  await expect(
    consumers.getByRole('link', { name: 'Open Dashboard Credit exposure dashboard in Databricks' })
  ).toBeVisible();
  await expect(consumers.getByRole('link', { name: 'Open Genie room Loan analysis room in Databricks' })).toBeVisible();
  await expect(
    indirectLinks.getByRole('link', { name: 'Open Notebook Portfolio risk notebook in Databricks' })
  ).toBeVisible();
  await expect(indirectLinks.getByRole('listitem').filter({ hasText: 'Portfolio risk notebook' })).toContainText(
    'Via proactive_zero_ops_catalog.proactive_zero_ops_gold.portfolio_expected_loss'
  );

  const effectiveRow = page.getByRole('button', { name: /Inspect direct impact on .*effective_ead/ });
  const utilizationRow = page.getByRole('button', { name: /Inspect direct impact on .*utilization_ratio/ });
  await effectiveRow.click();
  await expect(effectiveRow).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: `Hide observed consumers of ${LOAN_EXPOSURE_ASSET}` })).toBeVisible();
  await utilizationRow.click();
  await expect(utilizationRow).toHaveAttribute('aria-pressed', 'true');
  await expect(effectiveRow).toHaveAttribute('aria-pressed', 'false');
  await expect(consumers).toBeVisible();
});

test('uses one type prefix for a verified dashboard fallback title', async ({ page }) => {
  const fallbackUsage = structuredClone(usage);
  const loanExposure = fallbackUsage.assets.find((entry) => entry.asset === LOAN_EXPOSURE_ASSET);
  const dashboard = loanExposure?.objects.find((object) => object.kind === 'dashboard');
  if (dashboard === undefined) throw new Error('Expected a dashboard fixture');
  dashboard.title = 'Dashboard 01f1bd34786615c9b5b29d2cbfbc2112';

  await page.unroute(`**/api/assessments/${REFERENCE}/usage`);
  await page.route(`**/api/assessments/${REFERENCE}/usage`, async (route) => fulfillJson(route, fallbackUsage));
  await page.goto(`/assessments/${REFERENCE}`);
  await page.getByRole('button', { name: `Show observed consumers of ${LOAN_EXPOSURE_ASSET}` }).click();

  const link = page.getByRole('link', { name: `Open ${dashboard.title} in Databricks` });
  await expect(link).toHaveText(dashboard.title);
  await expect(link).toHaveAttribute('href', dashboard.url);
  await expect(link).toHaveAttribute('aria-label', `Open ${dashboard.title} in Databricks`);
});

test('opens the table group from keyboard-selected graph nodes and keeps their evidence distinct', async ({ page }) => {
  await page.goto(`/assessments/${REFERENCE}`);

  const graph = page.getByLabel('Impact lineage graph');
  const effectiveNode = graph.getByTestId('rf__node-impact-impact-2');
  await effectiveNode.focus();
  await page.keyboard.press('Enter');
  const openGroup = page.getByRole('button', { name: `Hide observed consumers of ${LOAN_EXPOSURE_ASSET}` });
  await expect(openGroup).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('heading', { name: 'loan_exposure.effective_ead' })).toBeVisible();

  const utilizationNode = graph.getByTestId('rf__node-impact-impact-3');
  await utilizationNode.focus();
  await page.keyboard.press('Enter');
  await expect(openGroup).toBeVisible();
  await expect(page.getByRole('heading', { name: 'loan_exposure.utilization_ratio' })).toBeVisible();

  await openGroup.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: `Show observed consumers of ${LOAN_EXPOSURE_ASSET}` })).toHaveAttribute(
    'aria-expanded',
    'false'
  );
});

test('switches evidence between duplicate table nodes clicked on the graph', async ({ page }) => {
  await page.setViewportSize({ width: 1082, height: 720 });
  await page.goto(`/assessments/${REFERENCE}`);

  const graph = page.getByLabel('Impact lineage graph');
  const effectiveNode = graph.getByTestId('rf__node-impact-impact-2');
  const utilizationNode = graph.getByTestId('rf__node-impact-impact-3');
  const openGroup = page.getByRole('button', { name: `Hide observed consumers of ${LOAN_EXPOSURE_ASSET}` });
  const effectiveRow = page.getByRole('button', { name: /Inspect direct impact on .*effective_ead/ });
  const utilizationRow = page.getByRole('button', { name: /Inspect direct impact on .*utilization_ratio/ });

  await effectiveNode.click();
  await expect(openGroup).toHaveAttribute('aria-expanded', 'true');
  await expect(effectiveRow).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'loan_exposure.effective_ead' })).toBeVisible();

  await utilizationNode.click();
  await expect(openGroup).toHaveAttribute('aria-expanded', 'true');
  await expect(utilizationRow).toHaveAttribute('aria-pressed', 'true');
  await expect(effectiveRow).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('heading', { name: 'loan_exposure.utilization_ratio' })).toBeVisible();
});

test('distinguishes complete zero use from partial observed use', async ({ page }) => {
  const partial = structuredClone(usage);
  const loanExposure = partial.assets.find((asset) => asset.asset === LOAN_EXPOSURE_ASSET);
  if (loanExposure === undefined) throw new Error('Missing loan exposure fixture');
  loanExposure.complete = false;
  loanExposure.count = 1;
  loanExposure.directCount = 1;
  loanExposure.indirectCount = 0;
  loanExposure.byType = { query: 1, dashboard: 0, genie: 0, notebook: 0, pipeline: 0, job: 0, alert: 0 };
  loanExposure.objects = loanExposure.objects.slice(0, 1);
  await page.unroute(`**/api/assessments/${REFERENCE}/usage`);
  await page.route(`**/api/assessments/${REFERENCE}/usage`, async (route) => fulfillJson(route, partial));
  await page.goto(`/assessments/${REFERENCE}`);

  const partialTable = page.getByRole('button', { name: `Show observed consumers of ${LOAN_EXPOSURE_ASSET}` });
  await expect(partialTable).toContainText('1+ consumers');
  await partialTable.click();
  await expect(page.getByText('Lower bound: 1 distinct observed consumers', { exact: true })).toBeVisible();
  const partialDetails = page
    .getByRole('button', { name: `Hide observed consumers of ${LOAN_EXPOSURE_ASSET}` })
    .locator('..');
  await expect(partialDetails).toContainText('1+ direct · 0+ indirect');
  await expect(partialDetails.locator('dl div').filter({ hasText: 'Queries' }).locator('dd')).toHaveText('1+');
  await expect(partialDetails.locator('dl div').filter({ hasText: 'Dashboards' }).locator('dd')).toHaveText('0+');
  await expect(
    partialDetails.getByRole('region', { name: `Indirect consumers of ${LOAN_EXPOSURE_ASSET}` })
  ).toContainText('0+');
  await expect(page.getByText(/Only accessible observed objects are listed/)).toBeVisible();

  await page.getByRole('button', { name: /Inspect direct impact on .*effective_ead/ }).click();
  await expect(page.getByRole('region', { name: `Observed usage of ${LOAN_EXPOSURE_ASSET}` })).toContainText(
    '1+ direct · 0+ indirect'
  );

  const zeroAsset = 'proactive_zero_ops_catalog.proactive_zero_ops_bronze.loan_accounts';
  const zeroTable = page.getByRole('button', { name: `Show observed consumers of ${zeroAsset}` });
  await expect(zeroTable).toContainText('0 consumers');
  await zeroTable.click();
  await expect(page.getByText('No observed consumers', { exact: true })).toBeVisible();
  await expect(page.getByText(/No visible objects observed in the last 30 days used this table/)).toBeVisible();
});

test('shows loading placeholders until the usage lookup resolves', async ({ page }) => {
  let heldRoute: Route | null = null;
  await page.unroute(`**/api/assessments/${REFERENCE}/usage`);
  await page.route(`**/api/assessments/${REFERENCE}/usage`, (route) => {
    heldRoute = route;
  });
  await page.goto(`/assessments/${REFERENCE}`);
  await page.getByRole('button', { name: `Show observed consumers of ${LOAN_EXPOSURE_ASSET}` }).click();
  await expect(page.getByRole('status', { name: 'Loading observed consumers' })).toBeVisible();
  if (heldRoute === null) throw new Error('Usage request was not made');
  await fulfillJson(heldRoute, usage);
  await expect(page.getByRole('button', { name: `Hide observed consumers of ${LOAN_EXPOSURE_ASSET}` })).toContainText(
    '5 consumers'
  );
});

test('shows a retryable usage failure without implying zero consumers', async ({ page }) => {
  let fail = true;
  await page.unroute(`**/api/assessments/${REFERENCE}/usage`);
  await page.route(`**/api/assessments/${REFERENCE}/usage`, async (route) => {
    if (fail) {
      fail = false;
      await fulfillJson(route, { code: 'USAGE_UNAVAILABLE', message: 'Lineage query failed.' }, 503);
    } else {
      await fulfillJson(route, usage);
    }
  });
  await page.goto(`/assessments/${REFERENCE}`);

  const table = page.getByRole('button', { name: `Show observed consumers of ${LOAN_EXPOSURE_ASSET}` });
  await expect(table).toContainText('Usage unavailable');
  await table.click();
  await expect(page.getByText('Usage unavailable', { exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Retry usage' }).click();
  await expect(page.getByRole('button', { name: `Hide observed consumers of ${LOAN_EXPOSURE_ASSET}` })).toContainText(
    '5 consumers'
  );
});

test('synchronizes graph filters, impact selection, and GitHub-gated source evidence', async ({ page }) => {
  await page.goto(`/assessments/${REFERENCE}`);

  await page.getByRole('button', { name: /Inspect direct impact on .*effective_ead/ }).click();
  await expect(
    page.getByText('Numeric arithmetic still expects the previous type contract.', { exact: true }).first()
  ).toBeVisible();
  await expect(page.getByText('Parsed definition', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Authorize exact source evidence' }).click();
  const sourceSql = page.getByLabel('Downstream expression SQL');
  await expect(sourceSql).toBeVisible();
  await expect(sourceSql).toHaveAttribute('data-language', 'spark-sql');
  await expect(sourceSql).toContainText('CASE');
  await expect(sourceSql.locator('.sql-token-keyword')).not.toHaveCount(0);

  await page.getByRole('combobox', { name: 'Impact scope' }).click();
  await page.getByRole('option', { name: 'Direct breaks only' }).click();
  await expect(page.getByText('portfolio_expected_loss', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Fit impact graph to view' }).click();
  await page.getByRole('button', { name: 'Centre graph on changed column' }).click();
});

test('moves the dot field with the DAG and keeps node surfaces opaque', async ({ page }) => {
  await page.goto(`/assessments/${REFERENCE}`);

  const graph = page.getByLabel('Impact lineage graph');
  const pattern = graph.locator('.react-flow__background pattern');
  await expect(pattern).toHaveCount(1);
  const before = await pattern.getAttribute('patternTransform');
  await page.getByRole('button', { name: 'Centre graph on changed column' }).click();
  await expect.poll(() => pattern.getAttribute('patternTransform')).not.toBe(before);

  const directNode = graph.locator('.impact-node-direct-break').filter({ hasText: 'loan_exposure.effective_ead' });
  await expect(directNode).toHaveClass(/impact-node-direct-break/);
  const nodeBackground = await directNode.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(nodeBackground).not.toBe('rgba(0, 0, 0, 0)');
  expect(nodeBackground).not.toBe('transparent');
});

test('uses scroll fades while keeping desktop vertical scrollbars unobtrusive', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 720 });
  await page.goto(`/assessments/${REFERENCE}`);

  const assessmentScroll = page.getByTestId('assessment-scroll-region');
  await expect(assessmentScroll).toHaveAttribute('data-scroll-after', 'true');
  await expect(assessmentScroll).toHaveAttribute('data-scrolling', 'false');
  await assessmentScroll.evaluate((element) => {
    element.scrollTop = 80;
  });
  await expect(assessmentScroll).toHaveAttribute('data-scrolling', 'true');
  await expect(assessmentScroll).toHaveAttribute('data-scroll-before', 'true');

  await page.getByRole('button', { name: /Inspect direct impact on .*effective_ead/ }).click();
  const inspectorScroll = page.getByTestId('impact-inspector-scroll-region');
  await expect(inspectorScroll).toHaveAttribute('data-scroll-after', 'true');
  await inspectorScroll.evaluate((element) => {
    element.scrollTop = 80;
  });
  await expect(inspectorScroll).toHaveAttribute('data-scrolling', 'true');
});

test('runs the OBO sample only after selection and highlights the impacted column', async ({ page }) => {
  const analyticsRequests: Array<{ url: string; body: string }> = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/analytics/query/')) {
      analyticsRequests.push({ url: request.url(), body: request.postData() ?? '' });
    }
  });

  await page.goto(`/assessments/${REFERENCE}`);
  expect(analyticsRequests).toHaveLength(0);

  await page.getByRole('button', { name: /Inspect direct impact on .*effective_ead/ }).click();
  await expect(page.getByRole('heading', { name: 'Current dataset sample' })).toBeVisible();
  await expect(page.getByRole('cell', { name: /effective_ead Impacted decimal\(18,2\)/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'account_id string' })).toBeVisible();
  await expect(page.getByText('1250.5', { exact: true })).toBeVisible();
  expect(analyticsRequests).toHaveLength(1);
  expect(analyticsRequests[0]?.url).toContain('dataset_sample');
  expect(analyticsRequests[0]?.body).toContain('loan_exposure');
  expect(analyticsRequests[0]?.body.toLowerCase()).not.toContain('information_schema');
});

test('hides sample values when access is revoked after assessment load', async ({ page }) => {
  await page.unroute('**/api/analytics/query/dataset_sample*');
  await page.route('**/api/analytics/query/dataset_sample*', async (route) => {
    await fulfillSse(route, { type: 'error', error: 'INSUFFICIENT_PRIVILEGES' });
  });
  await page.goto(`/assessments/${REFERENCE}`);
  await page.getByRole('button', { name: /Inspect direct impact on .*effective_ead/ }).click();
  await expect(page.getByText('Sample access is no longer available', { exact: true })).toBeVisible();
  await expect(page.getByText('1250.5', { exact: true })).toHaveCount(0);
});

test('supports keyboard navigation across the persistent workbench tabs', async ({ page }) => {
  await page.goto(`/assessments/${REFERENCE}`);

  const assessmentTab = page.getByRole('tab', { name: 'Assessment' });
  const fixTab = page.getByRole('tab', { name: 'Fix' });
  const auditTab = page.getByRole('tab', { name: 'Audit' });

  await assessmentTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(fixTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Propose a fix' })).toBeVisible();

  await page.keyboard.press('ArrowRight');
  await expect(auditTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Commit audit' })).toBeVisible();
});

test('keeps the assessment usable without horizontal page overflow at desktop and narrow widths', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/assessments/${REFERENCE}`);

  const graphHeading = page.getByRole('heading', { name: 'Causal impact map' });
  await expect(graphHeading).toBeVisible();
  await expect(page.getByLabel('Impact lineage graph')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('Impact lineage graph')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Impact list' })).toBeVisible();
  await page.getByRole('button', { name: `Show observed consumers of ${LOAN_EXPOSURE_ASSET}` }).click();
  await expect(page.getByRole('link', { name: 'Open Query Exposure watch query in Databricks' })).toBeVisible();
  await page.getByRole('button', { name: /Inspect direct impact on .*effective_ead/ }).click();
  const mobileInspector = page.getByRole('dialog', { name: 'Impact evidence' });
  await expect(mobileInspector).toBeVisible();
  await expect(mobileInspector.getByText('5 distinct observed consumers', { exact: true })).toBeVisible();

  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Review context' }).click();
  await expect(page.getByText(REFERENCE, { exact: true }).last()).toBeVisible();
});

test('matches the PR #4 desktop and mobile visual baselines', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/assessments/${REFERENCE}`);
  await expect(page.getByRole('heading', { name: 'Causal impact map' })).toBeVisible();
  await page.getByRole('button', { name: /Inspect direct impact on .*effective_ead/ }).click();
  await expect(page.getByRole('heading', { name: 'Current dataset sample' })).toBeVisible();
  await expect(page).toHaveScreenshot('pr4-assessment-desktop.png', { animations: 'disabled' });

  await page.getByRole('button', { name: 'Authorize exact source evidence' }).click();
  const sourceSql = page.getByLabel('Downstream expression SQL');
  await expect(sourceSql).toContainText('CASE');
  const inspectorScroll = page.getByTestId('impact-inspector-scroll-region');
  await inspectorScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(inspectorScroll).toHaveAttribute('data-scroll-after', 'false');
  await expect(inspectorScroll).toHaveAttribute('data-scrolling', 'false');
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(page).toHaveScreenshot('pr4-assessment-desktop-dark.png', { animations: 'disabled' });

  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await page.getByRole('button', { name: 'Close impact evidence' }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Impact list' })).toBeVisible();
  await expect(page).toHaveScreenshot('pr4-assessment-mobile.png', { animations: 'disabled' });
});

test('uses semantic dark-theme colors and disables decorative motion', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto(`/assessments/${REFERENCE}`);
  await expect(page.getByLabel('Impact lineage graph')).toBeVisible();
  await expect(page.locator('.react-flow__edge.animated')).toHaveCount(0);
  const background = await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe('rgb(255, 255, 255)');
});

test('toggles and persists the selected color theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`/assessments/${REFERENCE}`);

  const darkModeButton = page.getByRole('button', { name: 'Switch to dark mode' });
  await expect(darkModeButton).toBeVisible();
  await darkModeButton.click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.getByRole('button', { name: 'Switch to light mode' })).toBeVisible();

  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await expect(page.locator('html')).toHaveClass(/light/);
});

test('loads the automatic proposal with its isolated commit and cherry-pick command', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route(`**/api/assessments/${REFERENCE}/fix-session`, async (route) => {
    await fulfillJson(route, {
      session: {
        id: 'fix-session-1',
        status: 'complete',
        message: 'Validated patch ready.',
      },
    });
  });
  await page.route('**/api/fix-sessions/fix-session-1/patch', async (route) => {
    await fulfillJson(route, {
      sessionId: 'fix-session-1',
      status: 'complete',
      patchDigest: PATCH_DIGEST,
      baseSha: HEAD_SHA,
      proposal: {
        repository: 'db-afeng/proactive-zero-ops',
        branch: 'omnigent/pr-4/fix-session',
        commitSha: PROPOSAL_SHA,
        commitUrl: `https://github.com/db-afeng/proactive-zero-ops/commit/${PROPOSAL_SHA}`,
        createdAt: '2026-09-28T10:04:00+10:00',
      },
      files: [
        {
          path: 'src/models/orders.sql',
          status: 'modified',
          additions: 3,
          deletions: 1,
          language: 'sql',
          original: 'select order_id, customer_id from raw.orders',
          modified: 'select order_id, customer_id, order_total\nfrom raw.orders\nwhere order_id is not null',
        },
      ],
      validations: [
        {
          name: 'Protected paths',
          status: 'passed',
          message: 'No protected path is modified.',
        },
        {
          name: 'Patch integrity',
          status: 'passed',
          message: 'Patch applies to the assessed head.',
        },
      ],
    });
  });

  await page.goto(`/assessments/${REFERENCE}#fix`);

  await expect(page.getByText('Isolated proposal ready', { exact: true })).toBeVisible();
  await expect(page.getByText('omnigent/pr-4/fix-session', { exact: true })).toBeVisible();
  await expect(page.getByText('src/models/orders.sql', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Protected paths', { exact: true })).toBeVisible();
  await expect(page.getByText('Patch integrity', { exact: true })).toBeVisible();
  await expect(page.getByText(`git cherry-pick ${PROPOSAL_SHA}`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Copy cherry-pick command' }).click();
  await expect(page.getByText('Cherry-pick command copied to clipboard.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`git cherry-pick ${PROPOSAL_SHA}`);
});

for (const status of [403, 404]) {
  test(`uses the same unavailable response for assessment HTTP ${String(status)}`, async ({ page }) => {
    await page.unroute('**/api/assessments/*');
    await page.route('**/api/assessments/*', async (route) => {
      await fulfillJson(route, { code: 'ASSESSMENT_UNAVAILABLE', message: 'This assessment is unavailable.' }, status);
    });

    await page.goto(`/assessments/unavailable-${String(status)}`);
    await expect(page.getByText('This assessment is unavailable.', { exact: true })).toBeVisible();
    await expect(page.getByText(`unavailable-${String(status)}`, { exact: true })).toHaveCount(0);
  });
}

test('shows a safe rerun-required state for a legacy assessment', async ({ page }) => {
  await page.unroute('**/api/assessments/*');
  await page.route(`**/api/assessments/${REFERENCE}`, async (route) => {
    await fulfillJson(route, {
      ...assessment,
      detailState: 'legacy',
      severity: 'none',
      headline: 'Detailed explanation is unavailable for this assessment.',
      recommendedAction: 'Re-run the assessment to generate verified change and lineage evidence.',
      source: { ...assessment.source, evidenceOrigin: 'unavailable' },
      confidence: { interpretation: null, discovery: 'unknown' },
      changes: [],
      impacts: [],
      graph: { nodes: [], edges: [] },
      disclosure: { state: 'full', notice: 'All referenced lineage assets are visible to you.' },
    });
  });
  await page.goto(`/assessments/${REFERENCE}`);
  await expect(page.getByText('Re-run the assessment to generate verified change and lineage evidence.')).toBeVisible();
  await expect(page.getByLabel('Impact lineage graph')).toHaveCount(0);
  await expect(page.getByText('raw model prose')).toHaveCount(0);
});

test('shows stale and empty evidence states without inventing impacts', async ({ page }) => {
  await page.unroute('**/api/assessments/*');
  await page.route(`**/api/assessments/${REFERENCE}`, async (route) => {
    await fulfillJson(route, {
      ...assessment,
      status: 'pass',
      severity: 'none',
      headline: 'No blocking downstream impact was identified.',
      recommendedAction: 'Re-run the assessment if downstream definitions changed.',
      source: { ...assessment.source, freshness: 'stale', evidenceOrigin: 'unavailable' },
      changes: [],
      impacts: [],
      graph: { nodes: [], edges: [] },
      disclosure: { state: 'full', notice: 'All referenced lineage assets are visible to you.' },
    });
  });
  await page.goto(`/assessments/${REFERENCE}`);
  await expect(page.getByText('Assessment is stale', { exact: true })).toBeVisible();
  await expect(page.getByText('No verified causal graph is available', { exact: true })).toBeVisible();
});

test('progresses slow loading to an actionable timeout', async ({ page }) => {
  await page.unroute('**/api/assessments/*');
  await page.clock.install();
  await page.route('**/api/assessments/*', () => {
    // Deliberately leave the request pending so the browser-side timeout owns the state transition.
  });
  await page.goto(`/assessments/${REFERENCE}`, { waitUntil: 'domcontentloaded' });
  await page.clock.fastForward(10_001);
  await expect(
    page.getByText('Checking workspace permissions and assessment evidence…', { exact: true })
  ).toBeVisible();
  await page.clock.fastForward(80_000);
  await expect(page.getByText('Assessment could not be loaded', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('explains when GitHub must be connected before exact expressions are shown', async ({ page }) => {
  await page.unroute(`**/api/assessments/${REFERENCE}/source-evidence`);
  await page.route(`**/api/assessments/${REFERENCE}/source-evidence`, async (route) => {
    await fulfillJson(
      route,
      { code: 'GITHUB_DISCONNECTED', message: 'Connect GitHub to view exact source evidence.' },
      409
    );
  });
  await page.goto(`/assessments/${REFERENCE}`);
  await page.getByRole('button', { name: /Inspect direct impact on .*effective_ead/ }).click();
  await page.getByRole('button', { name: 'Authorize exact source evidence' }).click();
  await expect(page.getByText('Source evidence is locked', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Connect GitHub' })).toBeVisible();
});

async function mockAssessmentApis(page: Page) {
  await page.route('**/api/assessments/*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await fulfillJson(route, assessment);
  });
  await page.route(`**/api/assessments/${REFERENCE}/usage`, async (route) => {
    await fulfillJson(route, usage);
  });
  await page.route('**/api/github/status', async (route) => {
    await fulfillJson(route, { connected: true, login: 'workspace-reviewer' });
  });
  await page.route('**/api/capabilities', async (route) => {
    await fulfillJson(route, { omnigent: { available: true } });
  });
  await page.route(`**/api/assessments/${REFERENCE}/fix-session`, async (route) => {
    await fulfillJson(route, { session: null });
  });
  await page.route('**/api/audit/*', async (route) => {
    await fulfillJson(route, { records: [] });
  });
  await page.route(`**/api/assessments/${REFERENCE}/source-evidence`, async (route) => {
    await fulfillJson(route, {
      schemaVersion: 1,
      assessmentReference: REFERENCE,
      pullRequestFilesUrl: 'https://github.com/db-afeng/proactive-zero-ops/pull/4/files',
      changes: [
        {
          id: 'change-1',
          filePath: 'src/credit_risk/transformations/bronze/loan_accounts.sql',
          diffUrl:
            'https://github.com/db-afeng/proactive-zero-ops/pull/4/files#diff-239abbbd3d957241319bc0767fd298474525eed408198882ea49d7da55dc868c',
          beforeExpression: 'CAST(outstanding_balance_raw AS DECIMAL(18, 2))',
          afterExpression: "CONCAT('AUD ', FORMAT_NUMBER(outstanding_balance_raw, 2))",
        },
      ],
      impacts: [
        { id: 'impact-1', targetExpression: 'outstanding_balance >= 0' },
        {
          id: 'impact-2',
          targetExpression:
            "CAST(a.outstanding_balance + a.undrawn_commitment * CASE WHEN a.product_type = 'Revolver' THEN 0.7500 WHEN a.product_type = 'Trade Finance' THEN 0.5000 ELSE 0.0000 END AS DECIMAL(18, 2))",
        },
        { id: 'impact-3', targetExpression: 'outstanding_balance / credit_limit' },
        { id: 'impact-4', targetExpression: null },
      ],
    });
  });
  await page.route('**/api/analytics/query/dataset_sample*', async (route) => {
    await fulfillSse(route, {
      type: 'result',
      data: [
        {
          row_json: { account_id: 'A-100', effective_ead: 1250.5, risk_band: 'medium' },
          row_type: 'struct<account_id:string,effective_ead:decimal(18,2),risk_band:string>',
        },
      ],
    });
  });
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function fulfillSse(route: Route, event: unknown) {
  await route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: `data: ${JSON.stringify(event)}\n\n`,
  });
}
