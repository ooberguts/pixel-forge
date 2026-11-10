import { showInspector } from './helpers/inspector';
import { test, expect } from '@playwright/test';
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import path from 'node:path';
import { parseGIF, decompressFrames } from 'gifuct-js';

const fixture = process.env.PIXEL_FORGE_GIF_FIXTURE;
test('real GIF supports optional frame editing, background removal, GIF and game asset pack exports', async ({
  page,
}) => {
  test.skip(!fixture, 'Set PIXEL_FORGE_GIF_FIXTURE to a local green-screen GIF.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Import image or video').setInputFiles(fixture!);
  await expect(page.getByTitle(path.basename(fixture!), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Frame editor', exact: true })).toBeVisible();
  await expect(page.getByLabel('Game asset export format')).toHaveValue('gif');
  const assertCanvasFits = async () => {
    const viewport = await page.locator('.sprite-viewport').boundingBox();
    const canvas = await page.getByLabel('Sprite drawing canvas', { exact: true }).boundingBox();
    expect(canvas!.x).toBeGreaterThanOrEqual(viewport!.x);
    expect(canvas!.y).toBeGreaterThanOrEqual(viewport!.y);
    expect(canvas!.x + canvas!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width);
    expect(canvas!.y + canvas!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height);
  };
  await page.setViewportSize({ width: 940, height: 700 });
  await page.getByRole('button', { name: 'Fit sprite canvas', exact: true }).click();
  await assertCanvasFits();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Fit sprite canvas', exact: true }).click();
  const download = async (button: string, name?: string) => {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: button, exact: true }).click();
    const file = (await (await pending).path())!;
    if (name) {
      await mkdir('test-results/fireball', { recursive: true });
      await copyFile(file, `test-results/fireball/${name}`);
    }
    return readFile(file);
  };
  const screenshot = async (name: string) => {
    const file = `test-results/fireball/${name}`;
    await page.screenshot({ path: file });
    const destination = process.env.PIXEL_FORGE_SCREENSHOT_DIR;
    if (destination) {
      await mkdir(destination, { recursive: true });
      await copyFile(file, path.join(destination, name));
    }
  };
  const originalFiles = unzipSync(await download('Save project'));
  const original = JSON.parse(strFromU8(originalFiles['project.json']));
  await showInspector(page, 'Tools');
  await page.getByRole('button', { name: 'Pixelate & remove background…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Pixelate & remove background', exact: true });
  await dialog.getByRole('button', { name: '128 px', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Remove background color', exact: true }).check();
  const sourceCanvas = page.getByLabel('Original animation frame', { exact: true });
  const sourceBounds = await sourceCanvas.boundingBox();
  const sourceX = Math.floor((5 / sourceBounds!.width) * original.width);
  const sourceY = Math.floor((5 / sourceBounds!.height) * original.height);
  const sourceOffset = (sourceY * original.width + sourceX) * 4;
  const sampledColor =
    '#' +
    [...originalFiles[original.frames[0].file].slice(sourceOffset, sourceOffset + 3)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
  await sourceCanvas.click({ position: { x: 5, y: 5 } });
  await expect(page.getByLabel('Conversion key color', { exact: true })).toHaveValue(sampledColor);
  await page.getByLabel('Conversion key strength').fill('140');
  await page.getByLabel('Conversion key softness').fill('60');
  await screenshot('unified-conversion-1440.png');
  await page.setViewportSize({ width: 940, height: 700 });
  await expect(
    dialog.getByRole('button', {
      name: `Apply to all ${original.frames.length} frames`,
      exact: true,
    }),
  ).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
  await screenshot('unified-conversion-940.png');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog
    .getByRole('button', { name: `Apply to all ${original.frames.length} frames`, exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const files = unzipSync(await download('Save project', 'fireball.pixelforge'));
  const doc = JSON.parse(strFromU8(files['project.json']));
  expect([doc.width, doc.height]).toEqual([128, 96]);
  expect(doc.frames.map((f: { duration: number }) => f.duration)).toEqual(
    original.frames.map((f: { duration: number }) => f.duration),
  );
  expect(doc.tags).toEqual(original.tags);
  expect(doc.pivot).toEqual({
    x: (original.pivot.x * doc.width) / original.width,
    y: (original.pivot.y * doc.height) / original.height,
  });
  for (const frame of doc.frames) {
    const pixels = files[frame.file];
    expect(pixels[3]).toBe(0);
    expect(pixels.filter((_, i) => i % 4 === 3).some((alpha) => alpha === 255)).toBe(true);
  }
  await page.getByRole('button', { name: 'Play sprite animation', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Pause sprite animation', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Pause sprite animation', exact: true }).click();
  // A small real pixel edit can be undone without disturbing the converted frames.
  const canvas = page.getByLabel('Sprite drawing canvas');
  await canvas.click({ position: { x: 2, y: 2 } });
  await page.getByRole('button', { name: 'Undo sprite edit', exact: true }).click();
  await expect(page.getByLabel('Game asset export format')).toHaveValue('gif');
  await download('Export GIF', 'fireball-transparent.gif');
  await page.getByRole('button', { name: 'Dismiss sprite notification', exact: true }).click();
  await screenshot('standalone-gif-editor.png');
  for (const width of [1440, 940]) {
    await page.setViewportSize({ width, height: width === 940 ? 700 : 900 });
    await showInspector(page, 'Export');
    await page.getByRole('button', { name: 'Fit sprite canvas', exact: true }).click();
    await assertCanvasFits();
    await expect(page.getByRole('button', { name: 'Export GIF', exact: true })).toBeInViewport();
    await page.waitForTimeout(250);
    await screenshot(`design-fireball-frames-${width}.png`);
  }
  await showInspector(page, 'Export');
  await page.getByLabel('Game asset export format').selectOption('pack');
  await download('Export game asset pack', 'fireball-game-assets.zip');
  await page.getByRole('button', { name: 'Undo sprite edit', exact: true }).click();
  const restoredFiles = unzipSync(await download('Save project'));
  const restored = JSON.parse(strFromU8(restoredFiles['project.json']));
  expect([restored.width, restored.height]).toEqual([original.width, original.height]);
  for (let i = 0; i < original.frames.length; i++)
    expect([...restoredFiles[restored.frames[i].file]]).toEqual([
      ...originalFiles[original.frames[i].file],
    ]);
});

test('real GIF uses Adjust media for direct background removal and GIF export', async ({
  page,
}) => {
  test.skip(!fixture, 'Set PIXEL_FORGE_GIF_FIXTURE to a local green-screen GIF.');
  const originalBytes = await readFile(fixture!);
  const originalGif = parseGIF(new Uint8Array(originalBytes).buffer);
  const originalFrames = decompressFrames(originalGif, true);
  await page.goto('/');
  await page.getByLabel('Import image or video').setInputFiles(fixture!);
  await expect(page.getByRole('heading', { name: 'GIF adjustments', exact: true })).toBeVisible();
  await expect(page.getByLabel('Video export format', { exact: true })).toHaveValue('gif');
  await showInspector(page, 'Background');
  await page.getByLabel('Alpha mode', { exact: true }).selectOption('key');
  await page.getByLabel('Key strength', { exact: true }).fill('140');
  await page.getByLabel('Edge softness', { exact: true }).fill('60');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export GIF', exact: true }).click();
  const exported = parseGIF(new Uint8Array(await readFile((await (await pending).path())!)).buffer);
  const frames = decompressFrames(exported, true);
  expect([exported.lsd.width, exported.lsd.height, frames.length]).toEqual([
    originalGif.lsd.width,
    originalGif.lsd.height,
    originalFrames.length,
  ]);
  expect(frames.map((frame) => frame.delay)).toEqual(originalFrames.map((frame) => frame.delay));
  expect(frames.every((frame) => frame.patch[3] === 0)).toBe(true);
  expect(await readFile(fixture!)).toEqual(originalBytes);
  const dismiss = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  for (const width of [1440, 940]) {
    await page.setViewportSize({ width, height: width === 940 ? 700 : 900 });
    await showInspector(page, 'Background');
    await expect(page.getByRole('button', { name: 'Export GIF', exact: true })).toBeInViewport();
    // Chrome on macOS can capture stale compositor tiles immediately after a viewport resize.
    await page.waitForTimeout(250);
    const destination = process.env.PIXEL_FORGE_SCREENSHOT_DIR || 'test-results/fireball';
    await mkdir(destination, { recursive: true });
    await page.screenshot({ path: path.join(destination, `unified-media-gif-${width}.png`) });
    await showInspector(page, 'Export');
    await page.screenshot({ path: path.join(destination, `design-fireball-export-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await showInspector(page, 'Background');
  await page.getByRole('button', { name: 'Change preview background', exact: true }).click();
  await expect(page.locator('.canvas-area')).toHaveClass(/background-dark/);
  await expect(page.getByLabel('Media preview', { exact: true })).toHaveCSS(
    'background-image',
    'none',
  );
  await page.waitForTimeout(250);
  await page.screenshot({
    path: path.join(
      process.env.PIXEL_FORGE_SCREENSHOT_DIR || 'test-results/fireball',
      'design-fireball-dark-1440.png',
    ),
  });
  // Preserve lossless keyed RGBA PNGs (including soft alpha) for real native codec verification.
  // Re-decoding the GIF above would only provide binary transparency.
  await showInspector(page, 'Export');
  await page.getByLabel('Video export format', { exact: true }).selectOption('pack');
  const pendingPack = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export game asset pack', exact: true }).click();
  const packBytes = await readFile((await (await pendingPack).path())!);
  const pack = unzipSync(packBytes);
  const metadataName = Object.keys(pack).find((name) => name.endsWith('.json'))!;
  const metadata = JSON.parse(strFromU8(pack[metadataName]));
  const pngNames = Object.keys(pack)
    .filter((name) => name.startsWith('frames/') && name.endsWith('.png'))
    .sort();
  expect(pngNames).toHaveLength(originalFrames.length);
  const output = '/private/tmp/pixel-forge-pipeline-fixture';
  await mkdir(path.join(output, 'frames'), { recursive: true });
  await writeFile(path.join(output, 'keyed-original-size.zip'), packBytes);
  await Promise.all(pngNames.map((name) => writeFile(path.join(output, name), pack[name])));
  await writeFile(
    path.join(output, 'manifest.json'),
    JSON.stringify(
      {
        width: originalGif.lsd.width,
        height: originalGif.lsd.height,
        frames: pngNames.map((file, index) => ({
          file,
          durationMs: metadata.frames[index].duration,
        })),
      },
      null,
      2,
    ),
  );
});
