import { expect, test } from '@playwright/test';

test('shows the deep-link entry state', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('Lineage Impact Studio');
  await expect(page.getByText('Lineage Impact Studio', { exact: true })).toBeVisible();
  await expect(page.getByText('Open an assessment from its pull request', { exact: true })).toBeVisible();
  await expect(page.getByText('Assessment references are intentionally not searchable here.')).toBeVisible();
});
