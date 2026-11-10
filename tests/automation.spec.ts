import { test, expect, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { gifFixture } from './helpers/gif-fixture';

async function command(page: Page, method: string, params: Record<string, unknown> = {}) {
  return page.evaluate(
    async ({ method, params }) => {
      const moduleUrl =
        performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((url) => new URL(url).pathname === '/src/automation/bridge.ts') ||
        '/src/automation/bridge.ts';
      const { executeAutomationCommand } = await import(moduleUrl);
      try {
        return { result: await executeAutomationCommand(method, params), error: '' };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), result: null };
      }
    },
    { method, params },
  );
}
async function state(page: Page, kind = 'sprite') {
  const response = await command(page, `${kind}.get_state`);
  expect(response.error).toBe('');
  return response.result as Record<string, any>;
}

test('API sprite edits are visible, atomic, revision-checked and undoable with exact RGBA exports', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Image editor', exact: true })).toBeVisible();
  const before = await state(page);
  const changed = await command(page, 'sprite.apply', {
    expectedRevision: before.revision,
    operations: [
      { type: 'pixels', frame: 0, pixels: [{ x: 0, y: 0, rgba: [10, 20, 30, 127] }] },
      { type: 'duration', frame: 0, duration: 420 },
      { type: 'rename', name: 'api-sprite' },
      { type: 'pivot', x: 1.5, y: 30 },
    ],
  });
  expect(changed.error).toBe('');
  const after = await state(page);
  expect(after.revision).toBe(changed.result.revision);
  expect(after.revision).not.toBe(before.revision);
  await command(page, 'app.set_workspace', { workspace: 'sprites' });
  await expect(page.getByLabel('Asset name', { exact: true })).toHaveValue('api-sprite');
  await expect(page.getByLabel('Frame duration (ms)', { exact: true })).toHaveValue('420');
  const exported = await command(page, 'sprite.export', { format: 'project' });
  expect(exported.error).toBe('');
  const archive = unzipSync(Buffer.from(exported.result.base64, 'base64'));
  const manifest = JSON.parse(strFromU8(archive['project.json']));
  expect([...archive[manifest.frames[0].file].slice(0, 4)]).toEqual([10, 20, 30, 127]);
  expect(manifest.pivot).toEqual({ x: 1.5, y: 30 });
  const preview = await command(page, 'sprite.get_frame', { frame: 0 });
  expect(preview.error).toBe('');
  expect(preview.result).toMatchObject({
    revision: after.revision,
    width: 32,
    height: 32,
    mimeType: 'image/png',
  });
  expect(Buffer.from(preview.result.base64, 'base64').subarray(1, 4).toString()).toBe('PNG');
  const stale = await command(page, 'sprite.apply', {
    expectedRevision: before.revision,
    operations: [{ type: 'rename', name: 'stale' }],
  });
  expect(stale.error).toContain('changed');
  const partial = await command(page, 'sprite.apply', {
    expectedRevision: after.revision,
    operations: [
      { type: 'rename', name: 'partial' },
      { type: 'duration', frame: 0, duration: 0 },
    ],
  });
  expect(partial.error).toContain('duration');
  expect((await state(page)).revision).toBe(after.revision);
  const undone = await command(page, 'sprite.undo', { expectedRevision: after.revision });
  expect(undone.error).toBe('');
  await expect(page.getByLabel('Asset name', { exact: true })).toHaveValue('slime');
  const redone = await command(page, 'sprite.redo', { expectedRevision: undone.result.revision });
  expect(redone.error).toBe('');
  await expect(page.getByLabel('Asset name', { exact: true })).toHaveValue('api-sprite');
  expect(errors).toEqual([]);
});

test('API refuses edits during playback or dialogs and replacement requires intent plus current revision', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Image editor', exact: true })).toBeVisible();
  const initial = await state(page);
  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  const busy = await command(page, 'sprite.apply', {
    expectedRevision: initial.revision,
    operations: [{ type: 'rename', name: 'blocked' }],
  });
  expect(busy.error).toContain('busy');
  await page.keyboard.press('Escape');
  await command(page, 'app.set_workspace', { workspace: 'sprites' });
  await page.getByRole('button', { name: 'Play sprite animation', exact: true }).click();
  expect(
    (
      await command(page, 'sprite.apply', {
        expectedRevision: initial.revision,
        operations: [{ type: 'rename', name: 'blocked' }],
      })
    ).error,
  ).toContain('busy');
  await page.getByRole('button', { name: 'Pause sprite animation', exact: true }).click();
  const original = await command(page, 'sprite.export', { format: 'project' });
  const renamed = await command(page, 'sprite.apply', {
    expectedRevision: initial.revision,
    operations: [{ type: 'rename', name: 'keep-me' }],
  });
  expect(renamed.error).toBe('');
  const importParams = {
    format: 'project',
    name: 'slime.pixelforge',
    base64: original.result.base64,
    expectedRevision: renamed.result.revision,
  };
  expect((await command(page, 'sprite.import', importParams)).error).toContain('replace:true');
  expect(
    (await command(page, 'sprite.import', { ...importParams, base64: 'AAAA', replace: true }))
      .error,
  ).not.toBe('');
  await expect(page.getByLabel('Asset name', { exact: true })).toHaveValue('keep-me');
  const replaced = await command(page, 'sprite.import', { ...importParams, replace: true });
  expect(replaced.error).toBe('');
  await expect(page.getByLabel('Asset name', { exact: true })).toHaveValue('slime');
  expect(
    (await command(page, 'sprite.undo', { expectedRevision: replaced.result.revision })).error,
  ).toBe('');
  await expect(page.getByLabel('Asset name', { exact: true })).toHaveValue('keep-me');
});

test('API imports and configures a converter source, previews it and transfers the current pixels', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Image editor', exact: true })).toBeVisible();
  const initial = await state(page, 'converter');
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 32;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(255,0,0,0.5)';
    ctx.fillRect(32, 0, 32, 32);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const imported = await command(page, 'converter.import', {
    expectedRevision: initial.revision,
    name: 'api-alpha.png',
    mimeType: 'image/png',
    base64,
    replace: true,
  });
  expect(imported.error).toBe('');
  const opened = await state(page, 'converter');
  expect(opened.revision).toBe(imported.result.revision);
  expect(opened.source).toMatchObject({
    name: 'api-alpha.png',
    width: 64,
    height: 32,
    sample: false,
  });
  const configured = await command(page, 'converter.configure', {
    expectedRevision: opened.revision,
    settings: { width: 32, palette: 'original', dither: 'none', alpha: 'preserve' },
  });
  expect(configured.error).toBe('');
  const converted = await state(page, 'converter');
  expect(converted.revision).toBe(configured.result.revision);
  expect(
    (
      await command(page, 'converter.configure', {
        expectedRevision: opened.revision,
        settings: { width: 64 },
      })
    ).error,
  ).toContain('changed');
  const preview = await command(page, 'converter.preview');
  expect(preview.error).toBe('');
  expect(preview.result).toMatchObject({ width: 32, height: 16, revision: converted.revision });
  const target = await state(page);
  const transferred = await command(page, 'converter.transfer', {
    expectedRevision: converted.revision,
    expectedSpriteRevision: target.revision,
    replace: true,
  });
  expect(transferred.error).toBe('');
  await expect(page.getByRole('heading', { name: 'Frame editor', exact: true })).toBeVisible();
  const sprite = await state(page);
  expect(sprite).toMatchObject({ width: 32, height: 16, revision: transferred.result.revision });
  expect(sprite.frames).toHaveLength(1);
  const exported = await command(page, 'sprite.export', { format: 'project' });
  const archive = unzipSync(Buffer.from(exported.result.base64, 'base64'));
  const manifest = JSON.parse(strFromU8(archive['project.json']));
  const pixels = archive[manifest.frames[0].file];
  expect(pixels[3]).toBe(0);
  expect(pixels[31 * 4 + 3]).toBeGreaterThan(120);
  expect(pixels[31 * 4 + 3]).toBeLessThan(135);
  expect((await state(page, 'converter')).source.name).toBe('api-alpha.png');
});

test('API imports a GIF into Adjust media and transfers original timing with keyed alpha', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Image editor', exact: true })).toBeVisible();
  const source = await state(page, 'converter');
  const bytes = gifFixture(
    [
      { colors: [...Array(8).fill(2), ...Array(8).fill(1)], delay: 10, dispose: 2 },
      { colors: [...Array(8).fill(2), ...Array(8).fill(3)], delay: 17, dispose: 2 },
    ],
    16,
    4,
  );
  const imported = await command(page, 'converter.import', {
    expectedRevision: source.revision,
    replace: true,
    name: 'api-animation.gif',
    mimeType: 'image/gif',
    base64: Buffer.from(bytes).toString('base64'),
  });
  expect(imported.error).toBe('');
  const adjusted = await command(page, 'converter.configure', {
    expectedRevision: imported.result.revision,
    settings: {
      width: 16,
      palette: 'original',
      alpha: 'key',
      keyColor: '#00ff00',
      keyTolerance: 20,
      keySoftness: 0,
    },
  });
  expect(adjusted.error).toBe('');
  const sprite = await state(page);
  const transferred = await command(page, 'converter.transfer', {
    expectedRevision: adjusted.result.revision,
    expectedSpriteRevision: sprite.revision,
    replace: true,
  });
  expect(transferred.error).toBe('');
  const exported = await command(page, 'sprite.export', { format: 'project' });
  expect(exported.error).toBe('');
  const archive = unzipSync(Buffer.from(exported.result.base64, 'base64'));
  const manifest = JSON.parse(strFromU8(archive['project.json']));
  expect([manifest.width, manifest.height, manifest.gifRepeat]).toEqual([16, 1, 4]);
  expect(manifest.frames.map((frame: { duration: number }) => frame.duration)).toEqual([100, 170]);
  expect(archive[manifest.frames[0].file][3]).toBe(0);
  expect([...archive[manifest.frames[1].file].slice(8 * 4, 9 * 4)]).toEqual([0, 0, 255, 255]);
});
