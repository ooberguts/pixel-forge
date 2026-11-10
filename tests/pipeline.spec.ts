import { showInspector } from './helpers/inspector';
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { gifFixture } from './helpers/gif-fixture';

const mp4 = 'tests/fixtures/green-screen.mp4';
const keyedGif = {
  name: 'green-screen.gif',
  mimeType: 'image/gif',
  buffer: Buffer.from(
    gifFixture(
      [
        { colors: [...Array(8).fill(2), ...Array(8).fill(1)], delay: 10, dispose: 2 },
        { colors: [...Array(8).fill(2), ...Array(8).fill(3)], delay: 17, dispose: 2 },
      ],
      16,
      4,
    ),
  ),
};

type NativeCall = { command: string; args: Record<string, any> };
async function mockEncoderTransport(page: Page) {
  // Only IPC is mocked: the real UI, GIF decoder, processing and PNG encoder run.
  // Native codec correctness is covered separately by the Rust/FFmpeg checks.
  await page.addInitScript(() => {
    const state = window as typeof window & {
      isTauri: boolean;
      nativeCalls: { command: string; args: Record<string, unknown> }[];
      cancelSave: boolean;
      __TAURI_INTERNALS__: Record<string, unknown>;
      __TAURI_EVENT_PLUGIN_INTERNALS__: Record<string, unknown>;
    };
    state.isTauri = true;
    state.nativeCalls = [];
    state.cancelSave = false;
    let callback = 0;
    state.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    state.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callback,
      unregisterCallback: () => {},
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        state.nativeCalls.push({ command, args });
        if (command === 'plugin:dialog|save')
          return state.cancelSave
            ? null
            : `/test/${(args.options as { defaultPath: string }).defaultPath}`;
        if (command === 'begin_encode') return 'test-encode-session';
        if (command === 'video_export_capabilities')
          return { frameDurationsMs: true, formats: ['mov', 'webm'] };
        if (command === 'updater_configured') return false;
        if (command.startsWith('plugin:event|')) return 1;
        if (['write_encode_frame', 'finish_encode', 'abort_encode'].includes(command)) return null;
        throw Error(`Unexpected native command: ${command}`);
      },
    };
  });
}

async function nativeCalls(page: Page) {
  return page.evaluate(() => (window as typeof window & { nativeCalls: NativeCall[] }).nativeCalls);
}
async function download(page: Page, button: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  return readFile((await (await pending).path())!);
}
async function pngPixels(page: Page, bytes: Uint8Array) {
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    return {
      width: image.width,
      height: image.height,
      pixels: [...ctx.getImageData(0, 0, image.width, image.height).data],
    };
  }, Buffer.from(bytes).toString('base64'));
}
async function prepareMp4(page: Page) {
  await page.goto('/');
  await page.getByLabel('Import image or video').setInputFiles(mp4);
  await expect(page.getByRole('heading', { name: 'Video editor', exact: true })).toBeVisible();
  await showInspector(page, 'Appearance');
  await page.getByRole('button', { name: '64 px', exact: true }).click();
  await showInspector(page, 'Appearance');
  await page.getByLabel('Color palette', { exact: true }).selectOption('original');
  await showInspector(page, 'Background');
  await page.getByLabel('Alpha mode', { exact: true }).selectOption('key');
  await showInspector(page, 'Export');
  await page.getByLabel('Export scale', { exact: true }).selectOption('1');
}

test('MP4 exports a pixelated transparent GIF directly from Adjust media', async ({ page }) => {
  await prepareMp4(page);
  await showInspector(page, 'Export');
  await page.getByLabel('Video export format', { exact: true }).selectOption('gif');
  const bytes = await download(page, 'Export GIF');
  const gif = parseGIF(new Uint8Array(bytes).buffer);
  const frames = decompressFrames(gif, true);
  expect([gif.lsd.width, gif.lsd.height, frames.length]).toEqual([64, 48, 12]);
  expect(frames.reduce((sum, frame) => sum + frame.delay, 0)).toBe(1000);
  expect(frames.every((frame) => frame.patch[3] === 0)).toBe(true);
  expect(
    frames.every((frame) => frame.patch.some((value, i) => i % 4 === 3 && value === 255)),
  ).toBe(true);
  await expect(page.getByRole('heading', { name: 'Video editor', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Adjust media', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('MP4 exports an RGBA game asset pack directly with sampled timing and pivots', async ({
  page,
}) => {
  await prepareMp4(page);
  await showInspector(page, 'Timing');
  await page.getByLabel('Trim start', { exact: true }).fill('0.25');
  await showInspector(page, 'Timing');
  await page.getByLabel('Trim end', { exact: true }).fill('0.75');
  await showInspector(page, 'Export');
  await page.getByLabel('Video export format', { exact: true }).selectOption('pack');
  const files = unzipSync(await download(page, 'Export game asset pack'));
  const metadata = JSON.parse(strFromU8(files['green-screen.json']));
  expect(metadata.frames).toHaveLength(6);
  expect(
    metadata.frames.reduce((sum: number, frame: { duration: number }) => sum + frame.duration, 0),
  ).toBe(500);
  expect(metadata.frames[0].sourceSize).toEqual({ w: 64, h: 48 });
  expect(metadata.meta.pixelForge.pivotPixels).toEqual({ x: 32, y: 48 });
  expect(metadata.meta.frameTags).toEqual([
    { name: 'animation', from: 0, to: 5, direction: 'forward' },
  ]);
  const frameNames = Object.keys(files)
    .filter((name) => name.startsWith('frames/') && name.endsWith('.png'))
    .sort();
  expect(frameNames).toHaveLength(6);
  const first = await pngPixels(page, files[frameNames[0]]);
  expect([first.width, first.height, first.pixels[3]]).toEqual([64, 48, 0]);
  expect(first.pixels.some((value, i) => i % 4 === 3 && value === 255)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Video editor', exact: true })).toBeVisible();
});

for (const format of ['mov', 'webm'] as const) {
  test(`GIF removes its background at original size and sends exact timing and alpha to native ${format.toUpperCase()} export`, async ({
    page,
  }) => {
    await mockEncoderTransport(page);
    await page.goto('/');
    await page.getByLabel('Import image or video').setInputFiles(keyedGif);
    await expect(page.getByTitle(keyedGif.name, { exact: true })).toBeVisible();
    await showInspector(page, 'Background');
    await page.getByLabel('Alpha mode', { exact: true }).selectOption('key');
    await showInspector(page, 'Export');
    await page.getByLabel('Video export format', { exact: true }).selectOption(format);
    await page
      .getByRole('button', { name: `Export ${format === 'mov' ? 'MOV' : 'WebM'}`, exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await nativeCalls(page)).filter((call) => call.command === 'finish_encode').length,
      )
      .toBe(1);
    const calls = await nativeCalls(page);
    expect(calls.filter((call) => call.command === 'begin_encode')).toHaveLength(1);
    expect(calls.find((call) => call.command === 'begin_encode')!.args).toMatchObject({
      format,
      frameDurationsMs: [100, 170],
    });
    const frames = calls.filter((call) => call.command === 'write_encode_frame');
    expect(frames.map((call) => call.args.index)).toEqual([0, 1]);
    for (let i = 0; i < frames.length; i++) {
      const decoded = await pngPixels(page, new Uint8Array(frames[i].args.png));
      expect([decoded.width, decoded.height]).toEqual([16, 1]);
      for (let x = 0; x < 8; x++) expect(decoded.pixels[x * 4 + 3]).toBe(0);
      for (let x = 8; x < 16; x++)
        expect(decoded.pixels.slice(x * 4, x * 4 + 4)).toEqual(
          i === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255],
        );
    }
    expect(calls.filter((call) => call.command === 'abort_encode')).toHaveLength(0);
    await expect(page.getByRole('button', { name: 'Adjust media', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Cancelling the system save dialog must not start an encoder or change frames.
    await page.evaluate(() => {
      (window as typeof window & { cancelSave: boolean }).cancelSave = true;
    });
    await page
      .getByRole('button', { name: `Export ${format === 'mov' ? 'MOV' : 'WebM'}`, exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: `Export ${format === 'mov' ? 'MOV' : 'WebM'}`,
        exact: true,
      }),
    ).toBeEnabled();
    expect(
      (await nativeCalls(page)).filter((call) => call.command === 'begin_encode'),
    ).toHaveLength(1);
    await page.evaluate(() => {
      (window as typeof window & { cancelSave: boolean }).cancelSave = false;
    });
    await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Frame editor', exact: true })).toBeVisible();
    await expect(page.getByLabel('Game asset export format')).toHaveValue(format);
    await page
      .getByRole('button', { name: `Export ${format === 'mov' ? 'MOV' : 'WebM'}`, exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await nativeCalls(page)).filter((call) => call.command === 'finish_encode').length,
      )
      .toBe(2);
    const editedCalls = await nativeCalls(page);
    expect(editedCalls.filter((call) => call.command === 'begin_encode')[1].args).toMatchObject({
      format,
      frameDurationsMs: [100, 170],
    });
    expect(
      editedCalls
        .filter((call) => call.command === 'write_encode_frame')
        .slice(2)
        .map((call) => call.args.png),
    ).toEqual(frames.map((call) => call.args.png));
  });
}

test('GIF can export an unchanged-size keyed GIF or game asset pack without entering the frame editor', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Import image or video').setInputFiles(keyedGif);
  await expect(page.getByTitle(keyedGif.name, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove background', exact: true }).click();
  await expect(page.getByLabel('Alpha mode', { exact: true })).toHaveValue('key');
  await expect(page.getByRole('button', { name: 'Sample key color', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const preview = page.getByLabel('Media preview', { exact: true });
  const bounds = await preview.boundingBox();
  await preview.click({ position: { x: bounds!.width / 4, y: bounds!.height / 2 } });
  await expect(page.getByLabel('Key color', { exact: true })).toHaveValue('#00ff00');
  await expect(page.getByRole('button', { name: 'Sample key color', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.getByLabel('Video export format', { exact: true })).toHaveValue('gif');
  const gif = parseGIF(new Uint8Array(await download(page, 'Export GIF')).buffer);
  const frames = decompressFrames(gif, true);
  expect([gif.lsd.width, gif.lsd.height, frames.length]).toEqual([16, 1, 2]);
  expect(frames.map((frame) => frame.delay)).toEqual([100, 170]);
  expect(frames.every((frame) => frame.patch[3] === 0)).toBe(true);
  await showInspector(page, 'Export');
  await page.getByLabel('Video export format', { exact: true }).selectOption('pack');
  const files = unzipSync(await download(page, 'Export game asset pack'));
  const metadata = JSON.parse(strFromU8(files['green-screen.json']));
  expect(metadata.frames.map((frame: { duration: number }) => frame.duration)).toEqual([100, 170]);
  expect(metadata.frames[0].sourceSize).toEqual({ w: 16, h: 1 });
  expect(metadata.meta.pixelForge.pivotPixels).toEqual({ x: 8, y: 1 });
  await expect(page.getByRole('button', { name: 'Adjust media', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('MP4 frame edits become the adjustment source and remain recoverable after returning to the original', async ({
  page,
}) => {
  await prepareMp4(page);
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  await expect(page.getByRole('button', { name: /Select sprite frame/ })).toHaveCount(12);
  await page.getByLabel('Asset name', { exact: true }).fill('edited-animation');
  await page.getByLabel('Drawing color', { exact: true }).fill('#d02030');
  const canvas = page.getByLabel('Sprite drawing canvas', { exact: true });
  const bounds = await canvas.boundingBox();
  await canvas.click({ position: { x: bounds!.width / 128, y: bounds!.height / 96 } });
  await page.getByLabel('Frame duration (ms)', { exact: true }).fill('250');
  await page.getByLabel('Frame duration (ms)', { exact: true }).press('Enter');
  const before = unzipSync(await download(page, 'Save project'));
  const document = JSON.parse(strFromU8(before['project.json']));
  expect([...before[document.frames[0].file].slice(0, 4)]).toEqual([208, 32, 48, 255]);
  await page.getByRole('button', { name: 'Adjust media', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Frame adjustments', exact: true })).toBeVisible();
  await showInspector(page, 'Export');
  await page.getByLabel('Video export format', { exact: true }).selectOption('pack');
  const pack = unzipSync(await download(page, 'Export game asset pack'));
  const metadata = JSON.parse(strFromU8(pack['edited-animation.json']));
  expect(metadata.frames.map((frame: { duration: number }) => frame.duration)).toEqual(
    document.frames.map((frame: { duration: number }) => frame.duration),
  );
  const firstName = Object.keys(pack)
    .filter((name) => name.startsWith('frames/') && name.endsWith('.png'))
    .sort()[0];
  expect((await pngPixels(page, pack[firstName])).pixels.slice(0, 4)).toEqual([208, 32, 48, 255]);
  await showInspector(page, 'Appearance');
  await page.getByRole('button', { name: '32 px', exact: true }).click();
  await page.getByRole('button', { name: 'Return to original source', exact: true }).click();
  const restore = page.getByRole('dialog', { name: 'Return to original source?', exact: true });
  await expect(restore).toContainText('Your pixel edits and frame timing are kept');
  await restore.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Pixel width', { exact: true })).toHaveValue('32');
  await page.getByRole('button', { name: '64 px', exact: true }).click();
  await page.getByRole('button', { name: 'Return to original source', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Video editor', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit frames', exact: true }).click();
  const replacement = page.getByRole('dialog', { name: 'Replace edited frames?', exact: true });
  await expect(replacement).toContainText('edited-animation');
  await replacement.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Resume frame edits', exact: true }).click();
  const restored = unzipSync(await download(page, 'Save project'));
  expect(restored).toEqual(before);
});
