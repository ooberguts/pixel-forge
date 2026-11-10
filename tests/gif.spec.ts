import { showInspector } from './helpers/inspector';
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { gifFixture } from './helpers/gif-fixture';
import { parseGIF, decompressFrames } from 'gifuct-js';
function decodeGif(bytes: Uint8Array, _name: string) {
  const gif = parseGIF(new Uint8Array(bytes).buffer);
  const loop = gif.frames.find(
    (frame) => 'application' in frame && frame.application.id === 'NETSCAPE2.0',
  )?.application?.blocks;
  return {
    width: gif.lsd.width,
    height: gif.lsd.height,
    gifRepeat: loop ? loop[1] | (loop[2] << 8) : -1,
    frames: decompressFrames(gif, true).map((frame) => ({
      pixels: frame.patch,
      duration: frame.delay,
    })),
  };
}
import type { SpriteDocument } from '../src/sprites/model';

const input = {
  name: 'moving.gif',
  mimeType: 'image/gif',
  buffer: Buffer.from(
    gifFixture(
      [
        { colors: [1, 0, 0], dispose: 2, delay: 10 },
        { colors: [0, 2, 0], dispose: 2, delay: 17 },
        { colors: [0, 0, 3], dispose: 2, delay: 25 },
      ],
      3,
      4,
    ),
  ),
};
async function download(page: Page, button: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  return readFile((await (await pending).path())!);
}

test('GIF moves from Adjust media to frame edits, reordering and timing, then exports GIF and game assets', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Import image or video').setInputFiles(input);
  await expect(page.getByTitle(input.name, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  await expect(page.getByLabel('Asset name', { exact: true })).toHaveValue('moving');
  await expect(page.getByRole('button', { name: /Select sprite frame/ })).toHaveCount(3);
  await page.getByRole('button', { name: 'Select sprite frame 2', exact: true }).click();
  await page.getByRole('button', { name: 'Move frame left', exact: true }).click();
  await page.getByLabel('Frame duration (ms)', { exact: true }).fill('420');
  await page.getByLabel('Frame duration (ms)', { exact: true }).press('Enter');
  await page.getByLabel('Drawing color', { exact: true }).fill('#be3030');
  const canvas = page.getByLabel('Sprite drawing canvas', { exact: true });
  const box = await canvas.boundingBox();
  await canvas.click({ position: { x: box!.width / 6, y: box!.height / 2 } });
  const projectFiles = unzipSync(await download(page, 'Save project'));
  const manifest = JSON.parse(strFromU8(projectFiles['project.json']));
  const saved: SpriteDocument = {
    ...manifest,
    frames: manifest.frames.map((f: { file: string; duration: number }) => ({
      ...f,
      pixels: projectFiles[f.file],
    })),
  };
  expect(saved.frames.map((f) => f.duration)).toEqual([420, 100, 250]);
  expect([...saved.frames[0].pixels.slice(0, 4)]).toEqual([190, 48, 48, 255]);
  expect(saved.gifRepeat).toBe(4);
  await expect(page.getByLabel('Game asset export format')).toHaveValue('gif');
  await expect(page.getByLabel('GIF repeat')).toHaveValue('4');
  await showInspector(page, 'Export');
  await page.getByLabel('GIF repeat').selectOption('-1');
  const gif = decodeGif(await download(page, 'Export GIF'), 'edited.gif');
  expect(gif.frames.map((f) => [...f.pixels])).toEqual(saved.frames.map((f) => [...f.pixels]));
  expect(gif.frames.map((f) => f.duration)).toEqual([420, 100, 250]);
  expect(gif.gifRepeat).toBe(-1);
  await showInspector(page, 'Export');
  await page.getByLabel('Game asset export format').selectOption('pack');
  const pack = unzipSync(await download(page, 'Export game asset pack'));
  const json = JSON.parse(strFromU8(pack['moving.json']));
  expect(json.frames.map((f: { duration: number }) => f.duration)).toEqual([420, 100, 250]);
  expect(json.meta.frameTags).toEqual(saved.tags);
  expect(json.meta.pixelForge.pivotPixels).toEqual(saved.pivot);
  await page.getByRole('button', { name: 'Adjust media', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'GIF adjustments', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  await expect(page.getByLabel('Game asset export format')).toHaveValue('pack');
  await expect(page.getByLabel('Frame duration (ms)', { exact: true })).toHaveValue('420');
});

test('direct GIF import protects existing work, and malformed GIF leaves it intact', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  await page.getByLabel('Asset name', { exact: true }).fill('keep');
  await showInspector(page, 'Animation');
  await page
    .locator('summary')
    .filter({ hasText: /^\s*New or import frames\s*$/ })
    .click();
  await page.getByLabel('Sprite import type').selectOption('gif');
  await page.getByLabel('Import sprite frames').setInputFiles(input);
  const dialog = page.getByRole('dialog', { name: 'Replace sprite project?', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Asset name', { exact: true })).toHaveValue('keep');
  await expect(page.getByLabel('Game asset export format')).toHaveValue('pack');
  await page
    .getByLabel('Import sprite frames')
    .setInputFiles({ name: 'broken.gif', mimeType: 'image/gif', buffer: Buffer.from('invalid') });
  await expect(page.getByRole('alert')).toContainText('not a valid GIF');
  await expect(page.getByLabel('Asset name', { exact: true })).toHaveValue('keep');
  await expect(page.getByLabel('Game asset export format')).toHaveValue('pack');
  await page.getByLabel('Import sprite frames').setInputFiles(input);
  await dialog.getByRole('button', { name: 'Replace project', exact: true }).click();
  await expect(page.getByLabel('Asset name', { exact: true })).toHaveValue('moving');
  await expect(page.getByRole('heading', { name: 'Frame editor', exact: true })).toBeVisible();
  await expect(page.getByLabel('Game asset export format')).toHaveValue('gif');
});

test('video conversion can export a GIF with sampled frame timing', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Import image or video').setInputFiles('tests/fixtures/green-screen.webm');
  await showInspector(page, 'Appearance');
  await page.getByRole('button', { name: '64 px', exact: true }).click();
  await page.getByRole('button', { name: 'Edit pixels & frames', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Frame editor', exact: true })).toBeVisible();
  await showInspector(page, 'Export');
  await page.getByLabel('Game asset export format').selectOption('gif');
  const gif = decodeGif(await download(page, 'Export GIF'), 'video.gif');
  expect([gif.width, gif.height, gif.frames.length]).toEqual([64, 48, 12]);
  expect(gif.frames.reduce((sum, frame) => sum + frame.duration, 0)).toBe(1000);
});

async function savedProject(page: Page) {
  const files = unzipSync(await download(page, 'Save project'));
  const doc = JSON.parse(strFromU8(files['project.json']));
  return { doc, pixels: doc.frames.map((frame: { file: string }) => [...files[frame.file]]) };
}

test('the combined dialog removes a sampled GIF background across every frame, preserves timing and scales pivots; cancel and undo retain originals', async ({
  page,
}) => {
  await page.goto('/');
  const fixture = gifFixture(
    [
      { colors: [...Array(8).fill(2), ...Array(8).fill(1)], delay: 10, dispose: 2 },
      { colors: [...Array(8).fill(2), ...Array(8).fill(3)], delay: 17, dispose: 2 },
      {
        colors: [...Array(8).fill(2), ...Array(4).fill(1), ...Array(4).fill(3)],
        delay: 25,
        dispose: 2,
      },
    ],
    16,
    4,
  );
  await page
    .getByLabel('Import image or video')
    .setInputFiles({ name: 'background.gif', mimeType: 'image/gif', buffer: Buffer.from(fixture) });
  await expect(page.getByTitle('background.gif', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  const original = await savedProject(page);
  await showInspector(page, 'Tools');
  await page.getByRole('button', { name: 'Pixelate & remove background…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Pixelate & remove background', exact: true });
  await dialog.getByLabel('Conversion pixel width', { exact: true }).fill('8');
  await dialog.getByLabel('Conversion pixel width', { exact: true }).press('Enter');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await savedProject(page)).toEqual(original);

  await showInspector(page, 'Tools');
  await page.getByRole('button', { name: 'Pixelate & remove background…', exact: true }).click();
  await dialog.getByLabel('Conversion pixel width', { exact: true }).fill('8');
  await dialog.getByLabel('Conversion pixel width', { exact: true }).press('Enter');
  await dialog.getByRole('checkbox', { name: 'Remove background color', exact: true }).check();
  const originalCanvas = dialog.getByLabel('Original animation frame', { exact: true });
  const bounds = await originalCanvas.boundingBox();
  await originalCanvas.click({ position: { x: bounds!.width / 8, y: bounds!.height / 2 } });
  await expect(dialog.getByLabel('Conversion key color', { exact: true })).toHaveValue('#00ff00');
  await dialog.getByLabel('Conversion key softness').fill('0');
  await dialog.getByLabel('Conversion preview frame').fill('2');
  await expect(dialog.getByText('Frame 3 of 3 · 250 ms', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Apply to all 3 frames', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const converted = await savedProject(page);
  expect([converted.doc.width, converted.doc.height]).toEqual([8, 1]);
  expect(converted.doc.frames.map((frame: { duration: number }) => frame.duration)).toEqual([
    100, 170, 250,
  ]);
  expect(converted.doc.tags).toEqual(original.doc.tags);
  expect(converted.doc.gifRepeat).toBe(4);
  expect(converted.doc.pivot).toEqual({ x: 4, y: 1 });
  converted.pixels.forEach((pixels: number[]) => {
    expect(pixels[3]).toBe(0);
    expect(pixels[7 * 4 + 3]).toBe(255);
  });
  expect(converted.pixels.map((pixels: number[]) => pixels.slice(7 * 4, 7 * 4 + 3))).toEqual([
    [255, 0, 0],
    [0, 0, 255],
    [0, 0, 255],
  ]);
  await showInspector(page, 'Export');
  await page.getByLabel('Game asset export format').selectOption('pack');
  const pack = unzipSync(await download(page, 'Export game asset pack'));
  const metadata = JSON.parse(strFromU8(pack['background.json']));
  expect(metadata.meta.pixelForge.pivotPixels).toEqual({ x: 4, y: 1 });
  expect(metadata.meta.frameTags).toEqual(original.doc.tags);
  expect(metadata.frames.map((frame: { duration: number }) => frame.duration)).toEqual([
    100, 170, 250,
  ]);
  await page.getByRole('button', { name: 'Undo sprite edit', exact: true }).click();
  expect(await savedProject(page)).toEqual(original);
});

test('cancelling an in-progress frame conversion cannot apply a partial result', async ({
  page,
}) => {
  await page.goto('/');
  const fixture = gifFixture(
    Array.from({ length: 64 }, (_, index) => ({
      colors: [...Array(8).fill(2), ...Array(8).fill(index % 2 ? 1 : 3)],
      delay: 10,
      dispose: 2,
    })),
    16,
    0,
  );
  await page
    .getByLabel('Import image or video')
    .setInputFiles({ name: 'cancel.gif', mimeType: 'image/gif', buffer: Buffer.from(fixture) });
  await expect(page.getByTitle('cancel.gif', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  const original = await savedProject(page);
  await showInspector(page, 'Tools');
  await page.getByRole('button', { name: 'Pixelate & remove background…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Pixelate & remove background', exact: true });
  await dialog.getByLabel('Conversion pixel width', { exact: true }).fill('8');
  await dialog.getByLabel('Conversion pixel width', { exact: true }).press('Enter');
  await dialog.getByRole('button', { name: 'Apply to all 64 frames', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Applying to frame');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await savedProject(page)).toEqual(original);
  await expect(page.getByRole('button', { name: 'Undo sprite edit', exact: true })).toBeDisabled();
});

test('frame editor background removal exports GIF at original size with timing and alpha intact', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  const fixture = gifFixture(
    [
      { colors: [...Array(8).fill(2), ...Array(8).fill(1)], delay: 10, dispose: 2 },
      { colors: [...Array(8).fill(2), ...Array(8).fill(3)], delay: 17, dispose: 2 },
    ],
    16,
    4,
  );
  await page
    .getByLabel('Import image or video')
    .setInputFiles({ name: 'key-direct.gif', mimeType: 'image/gif', buffer: Buffer.from(fixture) });
  await expect(page.getByTitle('key-direct.gif', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Frame editor', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit frames', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByLabel('Game asset export format')).toHaveValue('gif');
  await expect(
    page.getByRole('button', { name: 'Toggle sprite grid', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(
    page.getByRole('button', { name: 'Toggle pivot guide', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(
    page.getByRole('button', { name: 'Pixelate & remove background…', exact: true }),
  ).toBeInViewport();
  const original = await savedProject(page);
  await showInspector(page, 'Tools');
  await page.getByRole('button', { name: 'Pixelate & remove background…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Pixelate & remove background', exact: true });
  await dialog.getByRole('button', { name: 'Original size', exact: true }).click();
  await expect(dialog.getByLabel('Conversion pixel width', { exact: true })).toHaveValue('16');
  await dialog.getByRole('checkbox', { name: 'Remove background color', exact: true }).check();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Conversion key color', { exact: true })).toBeInViewport();
  await expect(dialog.getByLabel('Conversion key strength', { exact: true })).toBeInViewport();
  await expect(dialog.getByLabel('Conversion key softness', { exact: true })).toBeInViewport();
  const originalCanvas = dialog.getByLabel('Original animation frame', { exact: true });
  const bounds = await originalCanvas.boundingBox();
  await originalCanvas.click({ position: { x: bounds!.width / 4, y: bounds!.height / 2 } });
  await expect(dialog.getByLabel('Conversion key color', { exact: true })).toHaveValue('#00ff00');
  await dialog.getByLabel('Conversion key strength', { exact: true }).fill('20');
  await dialog.getByLabel('Conversion key softness', { exact: true }).fill('10');
  await dialog.getByLabel('Conversion preview frame', { exact: true }).fill('1');
  await expect(dialog.getByText('Frame 2 of 2 · 170 ms', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/chroma-key.png' });
  await dialog.getByRole('button', { name: 'Apply to all 2 frames', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const keyed = await savedProject(page);
  expect([keyed.doc.width, keyed.doc.height]).toEqual([16, 1]);
  expect(keyed.doc.frames.map((frame: { duration: number }) => frame.duration)).toEqual([100, 170]);
  expect(keyed.doc.pivot).toEqual(original.doc.pivot);
  expect(keyed.doc.tags).toEqual(original.doc.tags);
  expect(keyed.doc.gifRepeat).toBe(4);
  keyed.pixels.forEach((pixels: number[], index: number) => {
    for (let x = 0; x < 8; x++) expect(pixels[x * 4 + 3]).toBe(0);
    expect(pixels.slice(8 * 4)).toEqual(original.pixels[index].slice(8 * 4));
  });
  // The standalone GIF path never requires selecting a game-asset format.
  await expect(page.getByLabel('Game asset export format')).toHaveValue('gif');
  const exported = decodeGif(await download(page, 'Export GIF'), 'key-direct.gif');
  expect([exported.width, exported.height, exported.frames.length]).toEqual([16, 1, 2]);
  expect(exported.frames.map((frame) => frame.duration)).toEqual([100, 170]);
  expect(exported.gifRepeat).toBe(4);
  expect(exported.frames.map((frame) => [...frame.pixels])).toEqual(keyed.pixels);
  await page.getByRole('button', { name: 'Undo sprite edit', exact: true }).click();
  expect(await savedProject(page)).toEqual(original);
});

test('one combined dialog exposes presets and background removal with reachable actions at 940 × 700', async ({
  page,
}) => {
  await page.setViewportSize({ width: 940, height: 700 });
  await page.goto('/');
  const fixture = gifFixture(
    [
      { colors: [...Array(8).fill(2), ...Array(8).fill(1)], delay: 10, dispose: 2 },
      { colors: [...Array(8).fill(2), ...Array(8).fill(3)], delay: 17, dispose: 2 },
    ],
    16,
    4,
  );
  await page
    .getByLabel('Import image or video')
    .setInputFiles({ name: 'combined.gif', mimeType: 'image/gif', buffer: Buffer.from(fixture) });
  await expect(page.getByTitle('combined.gif', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  const original = await savedProject(page);
  const entry = page.getByRole('button', { name: 'Pixelate & remove background…', exact: true });
  await expect(entry).toHaveCount(1);
  await expect(entry).toBeInViewport();
  await entry.click();
  const dialog = page.getByRole('dialog', { name: 'Pixelate & remove background', exact: true });
  const apply = dialog.getByRole('button', { name: 'Apply to all 2 frames', exact: true });
  const width = dialog.getByLabel('Conversion pixel width', { exact: true });
  const removeBackground = dialog.getByRole('checkbox', {
    name: 'Remove background color',
    exact: true,
  });
  await expect(apply).toBeDisabled();
  await expect(apply).toBeInViewport();
  await expect(width).toHaveValue('16');
  await expect(removeBackground).not.toBeChecked();
  const previewFrame = dialog.getByLabel('Conversion preview frame', { exact: true });
  await dialog.getByRole('button', { name: 'Play conversion preview', exact: true }).click();
  await expect.poll(() => previewFrame.inputValue()).not.toBe('0');
  await dialog.getByRole('button', { name: 'Pause conversion preview', exact: true }).click();
  const pausedFrame = await previewFrame.inputValue();
  await page.waitForTimeout(350);
  await expect(previewFrame).toHaveValue(pausedFrame);
  await expect(apply).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await savedProject(page)).toEqual(original);
  await entry.click();
  await dialog.getByRole('button', { name: '64 px', exact: true }).click();
  await expect(width).toHaveValue('64');
  await expect(apply).toBeEnabled();
  await dialog.getByRole('button', { name: '128 px', exact: true }).click();
  await expect(width).toHaveValue('128');
  await dialog.getByRole('button', { name: '256 px', exact: true }).click();
  await expect(width).toHaveValue('256');
  await dialog.getByRole('button', { name: 'Original size', exact: true }).click();
  await expect(width).toHaveValue('16');
  await expect(apply).toBeDisabled();
  await width.fill('8');
  await expect(width).toBeFocused();
  await expect(apply).toBeEnabled();
  await width.fill('0');
  await expect(width).toBeFocused();
  await expect(apply).toBeDisabled();
  await width.fill('16');
  await expect(apply).toBeDisabled();
  const dithering = dialog.getByLabel('Conversion dithering', { exact: true });
  await expect(dithering).toBeDisabled();
  await dialog.getByLabel('Conversion palette', { exact: true }).selectOption('earth');
  await expect(apply).toBeEnabled();
  await expect(dithering).toBeEnabled();
  await dithering.selectOption('bayer');
  await dialog.getByLabel('Conversion palette', { exact: true }).selectOption('original');
  await expect(dithering).toHaveValue('none');
  await expect(dithering).toBeDisabled();
  await expect(apply).toBeDisabled();
  await removeBackground.check();
  await expect(apply).toBeEnabled();
  await expect(width).toHaveValue('16');
  await removeBackground.uncheck();
  await expect(apply).toBeDisabled();
  await removeBackground.check();
  const source = dialog.getByLabel('Original animation frame', { exact: true });
  const bounds = await source.boundingBox();
  await source.click({ position: { x: bounds!.width / 4, y: bounds!.height / 2 } });
  await expect(dialog.getByLabel('Conversion key color', { exact: true })).toHaveValue('#00ff00');
  await dialog.getByRole('button', { name: '64 px', exact: true }).click();
  await expect(apply).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
  const scrollBody = await dialog.locator('.frame-conversion-scroll').boundingBox();
  const footer = await dialog.locator('.frame-conversion-footer').boundingBox();
  expect(scrollBody!.y + scrollBody!.height).toBeLessThanOrEqual(footer!.y + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/combined-conversion-940.png' });
  await apply.click();
  await expect(dialog).not.toBeVisible();
  const result = await savedProject(page);
  expect([result.doc.width, result.doc.height]).toEqual([64, 4]);
  expect(result.doc.frames.map((frame: { duration: number }) => frame.duration)).toEqual([
    100, 170,
  ]);
  expect(result.doc.tags).toEqual(original.doc.tags);
  expect(result.doc.gifRepeat).toBe(4);
  expect(result.doc.pivot).toEqual({ x: 32, y: 4 });
  result.pixels.forEach((pixels: number[]) => {
    expect(pixels[3]).toBe(0);
    expect(pixels[63 * 4 + 3]).toBe(255);
  });
  await page.getByRole('button', { name: 'Undo sprite edit', exact: true }).click();
  expect(await savedProject(page)).toEqual(original);
});

test('GIF export choice survives edits, workspace transitions and cancelled replacement', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Import image or video').setInputFiles(input);
  await expect(page.getByTitle(input.name, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  await expect(page.getByLabel('Game asset export format')).toHaveValue('gif');
  await showInspector(page, 'Export');
  await page.getByLabel('Game asset export format').selectOption('pack');
  await page.getByLabel('Asset name', { exact: true }).fill('keep-this-animation');
  await expect(page.getByLabel('Game asset export format')).toHaveValue('pack');
  const before = await savedProject(page);
  await page.getByRole('button', { name: 'Adjust media', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit frames', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  await expect(page.getByLabel('Game asset export format')).toHaveValue('pack');
  await showInspector(page, 'Animation');
  await page
    .locator('summary')
    .filter({ hasText: /^\s*New or import frames\s*$/ })
    .click();
  await page.getByLabel('Sprite import type').selectOption('gif');
  await page
    .getByLabel('Import sprite frames')
    .setInputFiles({ ...input, name: 'replacement.gif' });
  const confirmation = page.getByRole('dialog', {
    name: 'Replace sprite project?',
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Game asset export format')).toHaveValue('pack');
  expect(await savedProject(page)).toEqual(before);
  await page
    .getByLabel('Import sprite frames')
    .setInputFiles({ ...input, name: 'replacement.gif' });
  await confirmation.getByRole('button', { name: 'Replace project', exact: true }).click();
  await expect(page.getByLabel('Asset name', { exact: true })).toHaveValue('replacement');
  await expect(page.getByLabel('Game asset export format')).toHaveValue('gif');
  await expect(
    page.getByRole('button', { name: 'Toggle sprite grid', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(
    page.getByRole('button', { name: 'Toggle pivot guide', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
});
