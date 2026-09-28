import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const REFERENCE = 'assessment_K4z7pq2X';
const HEAD_SHA = 'f1e2d3c4b5a697887766554433221100ffeeddcc';
const PATCH_DIGEST = 'sha256:996a18d9270f53766792eb17edcf73d5540fe9dc56820cb5de161e1151c71dc8';

const assessment = {
  schemaVersion: 1,
  reference: REFERENCE,
  status: 'block',
  message: 'A potentially breaking downstream impact was identified.',
  source: {
    provider: 'github',
    createdAt: '2026-09-28T09:32:00+10:00',
    freshness: 'current',
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
  lineagePaths: [
    {
      segments: [
        {
          kind: 'asset',
          reference: 'production.analytics.orders',
          assetType: 'table',
        },
        {
          kind: 'restricted',
          // Deliberately hostile extra data verifies the client never renders restricted fields.
          reference: 'secret.hidden.customer_pii',
          assetType: 'table',
          count: 47,
        },
        {
          kind: 'asset',
          reference: 'production.reporting.executive_revenue',
          assetType: 'materialized_view',
        },
      ],
    },
    {
      segments: [
        {
          kind: 'asset',
          reference: 'production.analytics.orders',
          assetType: 'table',
        },
        {
          kind: 'asset',
          reference: 'production.ml.customer_features',
          assetType: 'view',
        },
      ],
    },
  ],
  disclosure: {
    state: 'partial',
    notice: 'Some lineage is hidden because you do not have access.',
  },
};

test.beforeEach(async ({ page }) => {
  await mockAssessmentApis(page);
});

test('deep links to a partially redacted assessment without leaking hidden data', async ({ page }) => {
  await page.goto(`/assessments/${REFERENCE}`);

  await expect(page).toHaveTitle('db-afeng/proactive-zero-ops #4 · Lineage Impact Studio');
  await expect(page.getByRole('heading', { name: 'Change is blocked for review' })).toBeVisible();
  await expect(page.getByText('Some lineage is restricted', { exact: true })).toBeVisible();
  await expect(page.getByText('production.analytics.orders', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('production.reporting.executive_revenue', { exact: true })).toBeVisible();
  await expect(page.getByText('Restricted segment', { exact: true })).toHaveCount(1);
  await expect(page.getByText('secret.hidden.customer_pii', { exact: true })).toHaveCount(0);
  await expect(page.getByText('47', { exact: true })).toHaveCount(0);
  await expect(page.getByText(`Reference ${REFERENCE}`, { exact: true }).first()).toBeVisible();
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

  const lineageHeading = page.getByRole('heading', { name: 'Accessible lineage' });
  const contextHeading = page.getByRole('heading', { name: 'Review context' });
  await expect(lineageHeading).toBeVisible();
  const desktopLineage = await lineageHeading.boundingBox();
  const desktopContext = await contextHeading.boundingBox();
  expect(desktopLineage).not.toBeNull();
  expect(desktopContext).not.toBeNull();
  expect(desktopContext?.x).toBeGreaterThan(desktopLineage?.x ?? 0);

  await page.setViewportSize({ width: 390, height: 844 });
  const narrowLineage = await lineageHeading.boundingBox();
  const narrowContext = await contextHeading.boundingBox();
  expect(narrowLineage).not.toBeNull();
  expect(narrowContext).not.toBeNull();
  expect(narrowContext?.y).toBeGreaterThan(narrowLineage?.y ?? 0);

  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
  await expect(page.getByText(`Reference ${REFERENCE}`, { exact: true }).last()).toBeVisible();
});

test('reviews a validated patch and blocks a commit when the PR head becomes stale', async ({ page }) => {
  let createBody: unknown;
  let approvalBody: unknown;
  let commitBody: unknown;

  await page.route(`**/api/assessments/${REFERENCE}/fix-sessions`, async (route) => {
    createBody = route.request().postDataJSON();
    await fulfillJson(route, {
      id: 'fix-session-1',
      status: 'complete',
      message: 'Validated patch ready.',
    });
  });
  await page.route('**/api/fix-sessions/fix-session-1/patch', async (route) => {
    await fulfillJson(route, {
      sessionId: 'fix-session-1',
      status: 'complete',
      patchDigest: PATCH_DIGEST,
      baseSha: HEAD_SHA,
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
  await page.route('**/api/fix-sessions/fix-session-1/approval', async (route) => {
    approvalBody = route.request().postDataJSON();
    await fulfillJson(route, { approvedAt: '2026-09-28T10:04:00+10:00' });
  });
  await page.route('**/api/fix-sessions/fix-session-1/commit', async (route) => {
    commitBody = route.request().postDataJSON();
    await fulfillJson(
      route,
      {
        code: 'STALE_HEAD',
        message: 'The pull request head changed after approval.',
      },
      409
    );
  });

  await page.goto(`/assessments/${REFERENCE}#fix`);
  await page.getByLabel('Guidance for Omnigent').fill('Preserve the downstream contract and add a null guard.');
  await page.getByRole('button', { name: 'Generate fix' }).click();

  await expect(page.getByText('src/models/orders.sql', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Protected paths', { exact: true })).toBeVisible();
  await expect(page.getByText('Patch integrity', { exact: true })).toBeVisible();
  expect(createBody).toEqual({
    guidance: 'Preserve the downstream contract and add a null guard.',
    expectedHeadSha: HEAD_SHA,
  });

  await page.getByRole('button', { name: 'Approve this patch' }).click();
  await expect(page.getByRole('button', { name: 'Commit approved patch' })).toBeVisible();
  expect(approvalBody).toEqual({ patchDigest: PATCH_DIGEST, expectedHeadSha: HEAD_SHA });

  await page.getByRole('button', { name: 'Commit approved patch' }).click();
  await expect(page.getByText('Pull request head must be reassessed', { exact: true })).toBeVisible();
  expect(commitBody).toEqual({ patchDigest: PATCH_DIGEST, expectedHeadSha: HEAD_SHA });
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

async function mockAssessmentApis(page: Page) {
  await page.route('**/api/assessments/*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await fulfillJson(route, assessment);
  });
  await page.route('**/api/github/status', async (route) => {
    await fulfillJson(route, { connected: true, login: 'workspace-reviewer' });
  });
  await page.route('**/api/capabilities', async (route) => {
    await fulfillJson(route, { omnigent: { available: true } });
  });
  await page.route('**/api/audit/*', async (route) => {
    await fulfillJson(route, { records: [] });
  });
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}
