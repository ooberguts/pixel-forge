import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import path from 'node:path';

test('sprite edits, undo/redo, tags, and logical-resolution game pack', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Game assets', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sprite animation', exact: true })).toBeVisible();
  await page.getByLabel('Asset name', { exact: true }).fill('hero');
  const canvas = page.getByLabel('Sprite drawing canvas');
  const alpha = () =>
    canvas.evaluate(
      (c) => (c as HTMLCanvasElement).getContext('2d')!.getImageData(1, 1, 1, 1).data[3],
    );
  expect(await alpha()).toBe(0);
  await canvas.click({ position: { x: 15, y: 15 } });
  await expect.poll(alpha).toBe(255);
  await page.getByRole('button', { name: 'Undo sprite edit', exact: true }).click();
  await expect.poll(alpha).toBe(0);
  await page.getByRole('button', { name: 'Redo sprite edit', exact: true }).click();
  await expect.poll(alpha).toBe(255);
  await page.getByLabel('Trim transparent frame borders', { exact: true }).check();
  await page.getByLabel('Edge extrusion', { exact: true }).fill('1');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export game asset pack', exact: true }).click();
  const download = await pending,
    files = unzipSync(await readFile((await download.path())!));
  const metadata = JSON.parse(strFromU8(files['hero.json']));
  expect(metadata.frames).toHaveLength(6);
  expect(metadata.frames[0].sourceSize).toEqual({ w: 32, h: 32 });
  expect(metadata.frames[0].duration).toBe(180);
  expect(metadata.meta.frameTags[0]).toMatchObject({ name: 'idle', from: 0, to: 5 });
  expect(metadata.meta.pixelForge.pivotPixels).toEqual({ x: 16, y: 32 });
  expect(metadata.meta.scale).toBe('1');
  expect(Object.keys(files).filter((k) => k.startsWith('frames/'))).toHaveLength(6);
  const dimensions = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + base64;
    await image.decode();
    return { w: image.width, h: image.height };
  }, Buffer.from(files['hero.png']).toString('base64'));
  expect(dimensions).toEqual(metadata.meta.size);
  expect(errors).toEqual([]);
  await page.getByRole('button', { name: 'Converter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Image editor', exact: true })).toBeVisible();
  expect(
    await page.getByLabel('Media preview').evaluate((c) => (c as HTMLCanvasElement).width),
  ).toBe(128);
});

test('video becomes an editable sprite animation and project saves timing', async ({ page }) => {
  await page.goto('/');
  await page
    .getByLabel('Import image or video')
    .setInputFiles(path.resolve('tests/fixtures/green-screen.webm'));
  await page.getByRole('button', { name: '64 px', exact: true }).click();
  await page.getByLabel('Alpha mode', { exact: true }).selectOption('key');
  await page.getByRole('button', { name: 'Create sprite animation', exact: true }).click();
  await expect(page.getByRole('button', { name: /Select sprite frame/ })).toHaveCount(12);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const download = await pending,
    projectFile = (await download.path())!;
  const files = unzipSync(await readFile(projectFile)),
    project = JSON.parse(strFromU8(files['project.json']));
  expect(project.frames.reduce((n: number, f: { duration: number }) => n + f.duration, 0)).toBe(
    1000,
  );
  expect(project.width).toBe(64);
  expect(project.height).toBe(48);
  const raw = files[project.frames[0].file];
  expect(raw[3]).toBe(0);
  await page
    .getByLabel('Open sprite project')
    .setInputFiles({
      name: 'roundtrip.pixelforge',
      mimeType: 'application/zip',
      buffer: await readFile(projectFile),
    });
  await expect(page.getByRole('button', { name: /Select sprite frame/ })).toHaveCount(12);
  await page.getByRole('button', { name: 'Play sprite animation', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Pause sprite animation', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Pause sprite animation', exact: true }).click();
});

test('sprite workspace fits a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Game assets', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
