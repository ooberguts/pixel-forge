import { showInspector } from './helpers/inspector';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import path from 'node:path';

test('image conversion exports correct dimensions and source alpha', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Image editor', exact: true })).toBeVisible();
  await expect(page.getByText('A little less resolution.')).toHaveCount(0);
  const fixture = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 40;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(255,0,0,0.5)';
    ctx.fillRect(40, 0, 40, 40);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('Import image or video').setInputFiles({
    name: 'alpha.png',
    mimeType: 'image/png',
    buffer: Buffer.from(fixture, 'base64'),
  });
  await expect(page.getByText('alpha.png', { exact: true })).toBeVisible();
  await showInspector(page, 'Appearance');
  await page.getByRole('button', { name: '64 px', exact: true }).click();
  await showInspector(page, 'Export');
  await page.getByLabel('Export scale', { exact: true }).selectOption('1');
  await showInspector(page, 'Appearance');
  await page.getByLabel('Color palette', { exact: true }).selectOption('mono');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export image', exact: true }).click();
  const download = await downloadPromise;
  const file = await download.path();
  const png = await readFile(file!);
  expect(png.readUInt32BE(16)).toBe(64);
  expect(png.readUInt32BE(20)).toBe(32);
  const alpha = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const c = document.createElement('canvas');
    c.width = image.width;
    c.height = image.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    return [ctx.getImageData(2, 2, 1, 1).data[3], ctx.getImageData(60, 2, 1, 1).data[3]];
  }, png.toString('base64'));
  expect(alpha[0]).toBe(0);
  expect(alpha[1]).toBeGreaterThan(120);
  expect(alpha[1]).toBeLessThan(135);
  expect(errors).toEqual([]);
});

test('video timeline, stationary anchors, chroma key and RGBA frame archive', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page
    .getByLabel('Import image or video')
    .setInputFiles(path.resolve('tests/fixtures/green-screen.webm'));
  await expect(page.getByRole('heading', { name: 'Video editor', exact: true })).toBeVisible();
  await showInspector(page, 'Appearance');
  await page.getByRole('button', { name: '64 px', exact: true }).click();
  await showInspector(page, 'Appearance');
  await page.getByLabel('Color palette', { exact: true }).selectOption('original');
  await showInspector(page, 'Background');
  await page.getByLabel('Alpha mode', { exact: true }).selectOption('key');
  await expect(page.getByRole('slider', { name: 'Key strength', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Edge softness', exact: true })).toBeVisible();
  await showInspector(page, 'Export');
  await page.getByLabel('Export scale', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Set anchor', exact: true }).click();
  const canvas = page.getByLabel('Media preview');
  const bounds = await canvas.boundingBox();
  await canvas.click({ position: { x: bounds!.width * 0.48, y: bounds!.height * 0.5 } });
  await expect(page.getByText('STATIONARY ANCHOR', { exact: true })).toBeVisible();
  await page.getByRole('slider', { name: 'Video timeline', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: 'Set anchor', exact: true }).click();
  await canvas.click({ position: { x: bounds!.width * 0.48, y: bounds!.height * 0.5 } });
  await expect(page.getByRole('button', { name: 'Timing', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByLabel('Enable stabilization', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Remove anchor at/ })).toHaveCount(2);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG sequence', exact: true }).click();
  const download = await downloadPromise;
  const zip = unzipSync(await readFile((await download.path())!));
  const manifest = JSON.parse(strFromU8(zip['manifest.json']));
  expect(manifest.fps).toBe(12);
  expect(manifest.frameCount).toBe(12);
  expect(manifest.width).toBe(64);
  expect(manifest.height).toBe(48);
  expect(manifest.stabilization.keyframes).toHaveLength(2);
  expect(manifest.settings.alpha).toBe('key');
  expect(Object.keys(zip).filter((k) => k.endsWith('.png'))).toHaveLength(12);
  const png = zip['frames/frame-000000.png'];
  const alpha = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const c = document.createElement('canvas');
    c.width = image.width;
    c.height = image.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    return [ctx.getImageData(2, 2, 1, 1).data[3], ctx.getImageData(30, 24, 1, 1).data[3]];
  }, Buffer.from(png).toString('base64'));
  expect(alpha).toEqual([0, 255]);
  expect(errors).toEqual([]);
});

test('utility interface fits a narrow screen and reports update availability', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'App settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(page.locator('.toast[role=status]')).toContainText('installed app');
});
