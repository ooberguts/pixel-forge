import { showInspector } from './helpers/inspector';
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import path from 'node:path';
import { gifFixture } from './helpers/gif-fixture';

const fixture = path.resolve('tests/fixtures/green-screen.webm');
async function download(page: Page, button: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  return readFile((await (await pending).path())!);
}
async function project(page: Page) {
  const files = unzipSync(await download(page, 'Save project'));
  return { files, doc: JSON.parse(strFromU8(files['project.json'])) };
}

test('workspace round trip retains edits, selection, tools, export options and undo history', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  await page.getByRole('button', { name: 'Select sprite frame 3', exact: true }).click();
  await page.getByRole('button', { name: 'Duplicate sprite frame', exact: true }).click();
  await page.getByRole('button', { name: 'Eraser (E)', exact: true }).click();
  await showInspector(page, 'Export');
  await page.getByRole('button', { name: 'Sheet settings', exact: true }).click();
  await page.getByLabel('Trim transparent frame borders', { exact: true }).check();
  await page.getByRole('button', { name: 'Adjust media', exact: true }).click();
  await showInspector(page, 'Appearance');
  await page.getByRole('button', { name: '64 px', exact: true }).click();
  await page.getByRole('button', { name: 'Resume frame edits', exact: true }).click();
  await expect(page.getByRole('button', { name: /Select sprite frame/ })).toHaveCount(7);
  await expect(
    page.getByRole('button', { name: 'Select sprite frame 4', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Eraser (E)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByLabel('Trim transparent frame borders', { exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Undo sprite edit', exact: true }).click();
  await expect(page.getByRole('button', { name: /Select sprite frame/ })).toHaveCount(6);
  await page.getByRole('button', { name: 'Redo sprite edit', exact: true }).click();
  await expect(page.getByRole('button', { name: /Select sprite frame/ })).toHaveCount(7);
});

test('transfer replacement is cancellable, traps focus, and saves a 1x copy regardless of export scale', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  await page.getByLabel('Asset name', { exact: true }).fill('keep-me');
  await page.getByRole('button', { name: 'Adjust media', exact: true }).click();
  await page.getByRole('button', { name: 'Return to original source', exact: true }).click();
  await showInspector(page, 'Appearance');
  await page.getByRole('button', { name: '64 px', exact: true }).click();
  await showInspector(page, 'Export');
  await page.getByLabel('Export scale', { exact: true }).selectOption('8');
  await page.getByRole('button', { name: 'Edit pixels & frames', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Replace edited frames?', exact: true });
  await expect(dialog).toContainText('keep-me');
  await expect(dialog).toContainText('unsaved changes');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Replace frames', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Edit pixels & frames', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Resume frame edits', exact: true }).click();
  await expect(page.getByLabel('Asset name', { exact: true })).toHaveValue('keep-me');
  await page.getByRole('button', { name: 'Adjust media', exact: true }).click();
  await page.getByRole('button', { name: 'Edit pixels & frames', exact: true }).click();
  await dialog.getByRole('button', { name: 'Replace frames', exact: true }).click();
  const { doc } = await project(page);
  expect([doc.width, doc.height, doc.frames.length]).toEqual([64, 48, 1]);
  await expect(page.getByText('Project saved', { exact: true })).toBeVisible();
});

test('preview grid does not alter PNG bytes unless explicitly included', async ({ page }) => {
  await page.goto('/');
  await showInspector(page, 'Appearance');
  await page.getByRole('button', { name: '32 px', exact: true }).click();
  const original = await download(page, 'Export image');
  await page.getByRole('button', { name: 'Toggle pixel grid', exact: true }).click();
  const previewGrid = await download(page, 'Export image');
  expect(previewGrid.equals(original)).toBe(true);
  await showInspector(page, 'Export');
  await page.getByLabel('Include grid in PNG', { exact: true }).check();
  const exportedGrid = await download(page, 'Export image');
  expect(exportedGrid.equals(original)).toBe(false);
  await showInspector(page, 'Export');
  await page.getByLabel('Export scale', { exact: true }).selectOption('1');
  await expect(page.getByLabel('Include grid in PNG', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Include grid in PNG', { exact: true })).not.toBeChecked();
  await download(page, 'Export image');
  await expect(page.locator('.toast[role=status]')).not.toContainText('grid included');
});

test('crop is explicit and undo restores pixels, dimensions and pivot; timing input accepts full values', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  const before = await project(page);
  await page.getByLabel('Frame duration (ms)', { exact: true }).fill('250');
  await page.getByLabel('Frame duration (ms)', { exact: true }).press('Enter');
  await expect(page.getByLabel('Frame duration (ms)', { exact: true })).toHaveValue('250');
  await page
    .locator('summary')
    .filter({ hasText: /^\s*Canvas size\s*$/ })
    .click();
  await page.getByLabel('Sprite canvas width', { exact: true }).fill('16');
  await page.getByRole('button', { name: 'Pad / crop canvas', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Crop all frames?', exact: true })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(page.getByLabel('Sprite drawing canvas')).toHaveAttribute('width', '32');
  await page.getByRole('button', { name: 'Pad / crop canvas', exact: true }).click();
  await page.getByRole('button', { name: 'Crop frames', exact: true }).click();
  await expect(page.getByLabel('Sprite drawing canvas')).toHaveAttribute('width', '16');
  await page.getByRole('button', { name: 'Undo sprite edit', exact: true }).click();
  await expect(page.getByLabel('Sprite canvas width', { exact: true })).toHaveValue('32');
  const after = await project(page);
  expect(after.doc.pivot).toEqual(before.doc.pivot);
  expect(after.doc.frames[0].duration).toBe(250);
  expect(after.files[after.doc.frames[0].file]).toEqual(before.files[before.doc.frames[0].file]);
});

test('native button keyboard activation, modal Escape, sampling and playback locks are consistent', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'App settings', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  await page.getByRole('button', { name: 'Sample color (I)', exact: true }).click();
  await page.getByLabel('Sprite drawing canvas').click({ position: { x: 2, y: 2 } });
  await expect(page.getByRole('status')).toContainText(['This pixel is transparent']);
  await page.getByRole('button', { name: 'Select sprite frame 2', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(
    page.getByRole('button', { name: 'Play sprite animation', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Play sprite animation', exact: true }).click();
  await expect(page.getByLabel('Frame duration (ms)', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Asset name', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Pause sprite animation', exact: true }).click();
  await expect(page.getByLabel('Frame duration (ms)', { exact: true })).toBeEnabled();
});

test('trimmed video transfers timing and alpha; converter survives; asset ZIP retains metadata', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Import image or video').setInputFiles(fixture);
  await showInspector(page, 'Appearance');
  await page.getByRole('button', { name: '64 px', exact: true }).click();
  await showInspector(page, 'Appearance');
  await page.getByLabel('Color palette', { exact: true }).selectOption('original');
  await showInspector(page, 'Background');
  await page.getByLabel('Alpha mode', { exact: true }).selectOption('key');
  await showInspector(page, 'Timing');
  await page.getByLabel('Trim start', { exact: true }).fill('0.25');
  await showInspector(page, 'Timing');
  await page.getByLabel('Trim end', { exact: true }).fill('0.75');
  await showInspector(page, 'Export');
  await page.getByLabel('Export scale', { exact: true }).selectOption('8');
  await page.getByRole('button', { name: 'Edit pixels & frames', exact: true }).click();
  await expect(page.getByRole('button', { name: /Select sprite frame/ })).toHaveCount(6);
  const { doc, files } = await project(page);
  expect(doc.frames.reduce((sum: number, f: { duration: number }) => sum + f.duration, 0)).toBe(
    500,
  );
  expect([doc.width, doc.height]).toEqual([64, 48]);
  expect(files[doc.frames[0].file][3]).toBe(0);
  const pack = unzipSync(await download(page, 'Export game asset pack'));
  const json = JSON.parse(strFromU8(pack['green-screen.json']));
  expect(json.meta.pixelForge.pivotPixels).toEqual({ x: 32, y: 48 });
  expect(json.meta.frameTags).toEqual([
    { name: 'animation', from: 0, to: 5, direction: 'forward' },
  ]);
  expect(json.frames.reduce((sum: number, f: { duration: number }) => sum + f.duration, 0)).toBe(
    500,
  );
  await page.getByRole('button', { name: 'Adjust media', exact: true }).click();
  await expect(page.getByLabel('Trim start', { exact: true })).toHaveValue('0.25');
  await expect(page.getByLabel('Trim end', { exact: true })).toHaveValue('0.75');
  await page.getByLabel('Import image or video').setInputFiles(fixture);
  await page
    .getByRole('dialog', { name: 'Replace source media?', exact: true })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(page.getByLabel('Trim start', { exact: true })).toHaveValue('0.25');
});

for (const size of [
  { width: 1440, height: 900 },
  { width: 940, height: 700 },
]) {
  test(`workflow layouts remain reachable at ${size.width} × ${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'Edit pixels & frames', exact: true }),
    ).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Export image', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `test-results/polish/converter-${size.width}.png` });
    await page.getByLabel('Import image or video').setInputFiles(fixture);
    await showInspector(page, 'Appearance');
    await page.getByRole('button', { name: '64 px', exact: true }).click();
    await showInspector(page, 'Background');
    await page.getByLabel('Alpha mode', { exact: true }).selectOption('key');
    await page.getByRole('button', { name: 'Set anchor', exact: true }).click();
    const canvas = page.getByLabel('Media preview');
    const box = await canvas.boundingBox();
    await canvas.click({ position: { x: box!.width / 2, y: box!.height / 2 } });
    await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
    await page.screenshot({ path: `test-results/polish/video-${size.width}.png` });
    await page.getByRole('button', { name: 'Edit pixels & frames', exact: true }).click();
    await page.getByRole('button', { name: 'Dismiss sprite notification', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Export game asset pack', exact: true }),
    ).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Pencil (B)', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    // The last selected thumbnail must scroll into the strip instead of disappearing off screen.
    await page.getByLabel('Sprite drawing canvas').focus();
    for (let frame = 1; frame < 12; frame++) await page.keyboard.press('ArrowRight');
    await expect(
      page.getByRole('button', { name: 'Select sprite frame 12', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.getByRole('button', { name: 'Select sprite frame 12', exact: true }),
    ).toBeInViewport();
    await page.screenshot({ path: `test-results/polish/sprites-${size.width}.png` });
  });
}

test('video shortcuts respect input focus and sprite playback starts at the selected frame', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Import image or video').setInputFiles(fixture);
  await page.getByLabel('Media preview').focus();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () => Number(await page.getByLabel('Video timeline', { exact: true }).inputValue()))
    .toBeGreaterThan(0.07);
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Pause video', exact: true })).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Play video', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  await page.getByRole('button', { name: 'Select sprite frame 3', exact: true }).click();
  await page.getByLabel('Frame duration (ms)', { exact: true }).fill('1000');
  await page.getByLabel('Frame duration (ms)', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Play sprite animation', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Select sprite frame 3', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Pause sprite animation', exact: true }).click();
});

test('invalid project leaves edits intact and sheet errors provide recovery', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  await page.getByLabel('Asset name', { exact: true }).fill('recoverable');
  await page.getByLabel('Open sprite project').setInputFiles({
    name: 'broken.pixelforge',
    mimeType: 'application/zip',
    buffer: Buffer.from('invalid'),
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Asset name', { exact: true })).toHaveValue('recoverable');
  await page.getByRole('button', { name: 'Dismiss sprite notification', exact: true }).click();
  await showInspector(page, 'Export');
  await page.getByRole('button', { name: 'Sheet settings', exact: true }).click();
  await page.getByLabel('Sheet columns', { exact: true }).fill('0');
  await expect(
    page.getByRole('button', { name: 'Export game asset pack', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('Sheet columns', { exact: true }).fill('4');
  await expect(
    page.getByRole('button', { name: 'Export game asset pack', exact: true }),
  ).toBeEnabled();
});

test('Frame editor opens GIF source adjustments from its header and advanced groups remain keyboard accessible', async ({
  page,
}) => {
  await page.setViewportSize({ width: 940, height: 700 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  const open = page.getByRole('button', { name: 'Open file', exact: true });
  await expect(open).toBeInViewport();
  const choosing = page.waitForEvent('filechooser');
  await open.click();
  await (
    await choosing
  ).setFiles({
    name: 'quick-start.gif',
    mimeType: 'image/gif',
    buffer: Buffer.from(
      gifFixture(
        [
          { colors: [1, 0, 0], delay: 10 },
          { colors: [0, 2, 0], delay: 17 },
        ],
        3,
        0,
      ),
    ),
  });
  await expect(page.getByTitle('quick-start.gif', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  await expect(page.getByLabel('Asset name', { exact: true })).toHaveValue('quick-start');
  await expect(page.getByRole('heading', { name: 'Frame editor', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Select sprite frame/ })).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: 'Pixelate & remove background…', exact: true }),
  ).toBeInViewport();
  for (const label of [
    'Sprite import type',
    'Sprite canvas width',
    'Pivot X',
    'Animation tag name',
    'Sheet columns',
  ])
    await expect(page.getByLabel(label, { exact: true })).not.toBeVisible();

  const canvasSize = page.locator('summary').filter({ hasText: /^\s*Canvas size\s*$/ });
  await canvasSize.focus();
  await page.keyboard.press('Space');
  await expect(page.getByLabel('Sprite canvas width', { exact: true })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Sprite canvas width', { exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(canvasSize).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByLabel('Sprite canvas width', { exact: true })).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Play sprite animation', exact: true }),
  ).toBeVisible();

  const pivot = page.locator('summary').filter({ hasText: /^\s*Shared pivot\s*$/ });
  await pivot.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Pivot X', { exact: true })).toBeFocused();
  await showInspector(page, 'Animation');
  await page
    .locator('summary')
    .filter({ hasText: /^\s*Animation tags\s*$/ })
    .press('Enter');
  await expect(page.getByLabel('Animation tag name', { exact: true })).toBeVisible();
  await showInspector(page, 'Export');
  await page.getByLabel('Game asset export format').selectOption('pack');
  await showInspector(page, 'Export');
  await page.getByRole('button', { name: 'Sheet settings', exact: true }).click();
  await expect(page.getByLabel('Sheet columns', { exact: true })).toBeVisible();
  await showInspector(page, 'Animation');
  await page
    .locator('summary')
    .filter({ hasText: /^\s*New or import frames\s*$/ })
    .press('Enter');
  await expect(page.getByLabel('Sprite import type', { exact: true })).toBeVisible();
});
