import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { showInspector } from './helpers/inspector';
import { gifFixture } from './helpers/gif-fixture';

const video = 'tests/fixtures/green-screen.mp4';
async function screenshot(page: Page, name: string) {
  for (const label of ['Dismiss notification', 'Dismiss sprite notification']) {
    const dismiss = page.getByRole('button', { name: label, exact: true });
    if (await dismiss.isVisible()) await dismiss.click();
  }
  const destination = process.env.PIXEL_FORGE_SCREENSHOT_DIR || 'test-results/design';
  await mkdir(destination, { recursive: true });
  await page.screenshot({ path: path.join(destination, name) });
}
async function project(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  return unzipSync(await readFile((await (await pending).path())!));
}
async function whollyInViewport(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  return box!;
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 940, height: 700 },
]) {
  test(`focused inspectors keep preview, timeline and export docked at ${size.width} × ${size.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.goto('/');
    await page.getByLabel('Import image or video').setInputFiles(video);
    await expect(page.getByRole('heading', { name: 'Video editor', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Appearance', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByLabel('Pixel width', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Alpha mode', { exact: true })).not.toBeVisible();
    await expect(page.getByLabel('Export scale', { exact: true })).not.toBeVisible();
    await page.getByRole('button', { name: '64 px', exact: true }).click();
    const preview = await whollyInViewport(page, '.canvas-area');
    expect(preview.height).toBeGreaterThanOrEqual(230);
    await whollyInViewport(page, '.timeline');
    await expect(
      page.getByRole('button', { name: 'Export PNG sequence', exact: true }),
    ).toBeInViewport();
    await page.getByRole('button', { name: 'Remove background', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Background', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByLabel('Alpha mode', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Sample key color', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Cancel picking', exact: true }).click();
    await page.getByRole('button', { name: 'Set anchor', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Timing', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByLabel('Enable stabilization', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel picking', exact: true }).click();
    await showInspector(page, 'Export');
    await page.getByLabel('Video export format', { exact: true }).selectOption('gif');
    await expect(page.getByRole('button', { name: 'Export GIF', exact: true })).toBeInViewport();
    await screenshot(page, `design-adjust-${size.width}.png`);
    await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Frame editor', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tools', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByLabel('Game asset export format')).not.toBeVisible();
    const editor = await whollyInViewport(page, '.sprite-viewport');
    expect(editor.height).toBeGreaterThanOrEqual(230);
    await whollyInViewport(page, '.sprite-timeline');
    await expect(page.getByRole('button', { name: 'Export GIF', exact: true })).toBeInViewport();
    await showInspector(page, 'Export');
    await expect(page.getByLabel('Game asset export format')).toHaveValue('gif');
    await page.getByLabel('Game asset export format').selectOption('pack');
    await expect(
      page.getByRole('button', { name: 'Export game asset pack', exact: true }),
    ).toBeInViewport();
    await screenshot(page, `design-frames-${size.width}.png`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test('inspector keyboard navigation and pivot shortcut reveal controls without changing frames or playback', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  const before = await project(page);
  const tools = page.getByRole('button', { name: 'Tools', exact: true });
  const animation = page.getByRole('button', { name: 'Animation', exact: true });
  const output = page.getByRole('button', { name: 'Export', exact: true });
  await tools.focus();
  await page.keyboard.press('Tab');
  await expect(animation).toBeFocused();
  await page.keyboard.press('Space');
  await expect(animation).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: 'Play sprite animation', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Home');
  await page.keyboard.press('End');
  await expect(
    page.getByRole('button', { name: 'Select sprite frame 1', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Tab');
  await expect(output).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Game asset export format')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Game asset export format')).toBeFocused();
  await page.getByLabel('Sprite drawing canvas').focus();
  await page.keyboard.press('p');
  await expect(tools).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Pivot X', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set pivot (P)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await project(page)).toEqual(before);
  await showInspector(page, 'Animation');
  await page.getByRole('button', { name: 'Adjust media', exact: true }).click();
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  await expect(animation).toHaveAttribute('aria-pressed', 'true');
});

test('source inspector buttons support ordinary keyboard navigation and exclude hidden controls', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Import image or video').setInputFiles(video);
  const appearance = page.getByRole('button', { name: 'Appearance', exact: true });
  await appearance.focus();
  await page.keyboard.press('Tab');
  const background = page.getByRole('button', { name: 'Background', exact: true });
  await expect(background).toBeFocused();
  await page.keyboard.press('Space');
  await expect(background).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Play video', exact: true })).toBeVisible();
  await expect(page.getByLabel('Pixel width', { exact: true })).not.toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Timing', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  const output = page.getByRole('button', { name: 'Export', exact: true });
  await expect(output).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Video export format', { exact: true })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Video export format', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Video timeline', { exact: true })).toHaveValue('0');
});

test('frame strip arrows move keyboard focus, Space keeps selection, and fractional timing is rejected', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  const before = await project(page);
  await page.getByRole('button', { name: 'Select sprite frame 1', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  const second = page.getByRole('button', { name: 'Select sprite frame 2', exact: true });
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Space');
  await expect(second).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: 'Play sprite animation', exact: true }),
  ).toBeVisible();
  const duration = page.getByLabel('Frame duration (ms)', { exact: true });
  const original = await duration.inputValue();
  await duration.fill('250.5');
  await duration.press('Enter');
  await expect(duration).toHaveValue(original);
  await expect(page.getByRole('alert')).toContainText('whole number');
  expect(await project(page)).toEqual(before);
  await duration.fill('250');
  await duration.press('Enter');
  await expect(duration).toHaveValue('250');
});

test('GIF stepping follows original frame boundaries and appearance reset restores original size and colors', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Import image or video').setInputFiles({
    name: 'variable-timing.gif',
    mimeType: 'image/gif',
    buffer: Buffer.from(
      gifFixture(
        [
          { colors: Array(16).fill(1), delay: 9 },
          { colors: Array(16).fill(2), delay: 17 },
          { colors: Array(16).fill(3), delay: 25 },
        ],
        16,
        0,
      ),
    ),
  });
  await expect(page.getByRole('heading', { name: 'GIF adjustments', exact: true })).toBeVisible();
  const timeline = page.getByLabel('Video timeline', { exact: true });
  await page.getByRole('button', { name: 'Next frame', exact: true }).click();
  await expect(timeline).toHaveValue('0.09');
  await page.getByRole('button', { name: 'Next frame', exact: true }).click();
  await expect(timeline).toHaveValue('0.26');
  await page.getByRole('button', { name: 'Previous frame', exact: true }).click();
  await expect(timeline).toHaveValue('0.09');
  await page.getByRole('button', { name: 'Previous frame', exact: true }).click();
  await expect(timeline).toHaveValue('0');
  await showInspector(page, 'Appearance');
  await page.getByRole('button', { name: '64 px', exact: true }).click();
  await expect(page.getByLabel('Pixel width', { exact: true })).toHaveValue('64');
  await page.getByRole('button', { name: 'Original size · 16 × 1', exact: true }).click();
  await expect(page.getByLabel('Pixel width', { exact: true })).toHaveValue('16');
  await page.getByLabel('Color palette', { exact: true }).selectOption('earth');
  await page.getByRole('button', { name: 'Reset adjustments', exact: true }).click();
  await expect(page.getByLabel('Color palette', { exact: true })).toHaveValue('original');
  await expect(page.getByLabel('Pixel width', { exact: true })).toHaveValue('16');
});
