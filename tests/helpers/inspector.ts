import { type Page } from '@playwright/test';

/** Follow the same inspector navigation a user uses; never unhide controls in the DOM. */
export async function showInspector(
  page: Page,
  panel: 'Appearance' | 'Background' | 'Timing' | 'Tools' | 'Animation' | 'Export',
) {
  const button = page.getByRole('button', { name: panel, exact: true });
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
}
