import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from './model';
import { exportSpriteVideo, spriteVideoPlan } from './videoExport';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  save: vi.fn(),
  pngBytes: vi.fn(),
  frameCanvas: vi.fn(),
  scaleCanvas: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save }));
vi.mock('../platform', () => ({ desktop: true, saveBytes: vi.fn() }));
vi.mock('../media', () => ({
  pngBytes: mocks.pngBytes,
  scaleCanvas: mocks.scaleCanvas,
  loadMedia: vi.fn(),
  disposeMedia: vi.fn(),
  seekVideo: vi.fn(),
  renderMedia: vi.fn(),
}));
vi.mock('./io', () => ({ frameCanvas: mocks.frameCanvas, safeName: (name: string) => name }));
function fixture() {
  const doc = createDocument(2, 1, 'timed');
  doc.frames[0].pixels.set([255, 0, 0, 255, 0, 0, 0, 0]);
  doc.frames[0].duration = 180;
  doc.frames.push({
    id: 'blue',
    duration: 70,
    pixels: new Uint8ClampedArray([0, 0, 255, 128, 0, 0, 0, 0]),
  });
  return doc;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.invoke.mockImplementation(async (command: string) =>
    command === 'video_export_capabilities'
      ? { frameDurationsMs: true, formats: ['mov', 'webm'] }
      : command === 'begin_encode'
        ? 'session'
        : undefined,
  );
  mocks.save.mockResolvedValue('/tmp/timed.mov');
  mocks.frameCanvas.mockImplementation((pixels, width, height) => ({ pixels, width, height }));
  mocks.scaleCanvas.mockImplementation((canvas, scale) => ({
    ...canvas,
    width: canvas.width * scale,
    height: canvas.height * scale,
  }));
  mocks.pngBytes.mockImplementation(
    async (canvas) => new Uint8Array([137, 80, 78, 71, ...canvas.pixels]),
  );
});

describe('timed frame video export', () => {
  it('preserves selected order, independent frame durations, scale and RGBA inputs', async () => {
    const doc = fixture(),
      original = doc.frames.map((frame) => [...frame.pixels]);
    const progress = vi.fn();
    expect(spriteVideoPlan(doc, [1, 0, 1], 4)).toEqual({
      order: [1, 0, 1],
      frameDurationsMs: [70, 180, 70],
      scale: 4,
      width: 8,
      height: 4,
      duration: 320,
    });
    expect(
      await exportSpriteVideo({
        doc,
        order: [1, 0, 1],
        format: 'mov',
        ffmpeg: '/ffmpeg',
        scale: 4,
        signal: new AbortController().signal,
        progress,
      }),
    ).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith('begin_encode', {
      output: '/tmp/timed.mov',
      format: 'mov',
      ffmpeg: '/ffmpeg',
      fps: 12,
      frameDurationsMs: [70, 180, 70],
    });
    expect(mocks.frameCanvas.mock.calls.map((args) => [...args[0]])).toEqual([
      original[1],
      original[0],
      original[1],
    ]);
    expect(mocks.scaleCanvas).toHaveBeenCalledTimes(3);
    const writes = mocks.invoke.mock.calls.filter((args) => args[0] === 'write_encode_frame');
    expect(writes.map((args) => args[1].index)).toEqual([0, 1, 2]);
    expect(writes[0][1].png.slice(4)).toEqual(original[1]);
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ fraction: 1, encoding: true });
    expect(mocks.invoke).toHaveBeenCalledWith('finish_encode', { id: 'session' });
    expect(mocks.invoke.mock.calls.some((args) => args[0] === 'abort_encode')).toBe(false);
    expect(doc.frames.map((frame) => [...frame.pixels])).toEqual(original);
  });
  it('rejects invalid order, scale and fractional durations rather than silently retiming', () => {
    const doc = fixture();
    expect(() => spriteVideoPlan(doc, [])).toThrow('valid animation range');
    expect(() => spriteVideoPlan(doc, [2])).toThrow('valid animation range');
    expect(() => spriteVideoPlan(doc, [0], 3)).toThrow('scale');
    doc.frames[0].duration = 180.5;
    expect(() => spriteVideoPlan(doc)).toThrow('whole-millisecond');
  });
  it('save cancellation starts no encoder and reports no successful output', async () => {
    mocks.save.mockResolvedValue(null);
    expect(
      await exportSpriteVideo({
        doc: fixture(),
        format: 'mov',
        ffmpeg: 'ffmpeg',
        signal: new AbortController().signal,
        progress: vi.fn(),
      }),
    ).toBe(false);
    expect(mocks.invoke.mock.calls.map((args) => args[0])).toEqual(['video_export_capabilities']);
  });
  it('refuses older native builds that would ignore per-frame timing', async () => {
    mocks.invoke.mockRejectedValue(new Error('Unknown command'));
    await expect(
      exportSpriteVideo({
        doc: fixture(),
        format: 'webm',
        ffmpeg: 'ffmpeg',
        signal: new AbortController().signal,
        progress: vi.fn(),
      }),
    ).rejects.toThrow('latest build');
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('cancels during PNG preparation and cleans the native session without finishing', async () => {
    const controller = new AbortController();
    mocks.pngBytes.mockImplementation(async () => {
      controller.abort(new DOMException('Cancelled', 'AbortError'));
      return new Uint8Array([137, 80, 78, 71]);
    });
    await expect(
      exportSpriteVideo({
        doc: fixture(),
        format: 'mov',
        ffmpeg: 'ffmpeg',
        signal: controller.signal,
        progress: vi.fn(),
      }),
    ).rejects.toThrow('Cancelled');
    expect(mocks.invoke).toHaveBeenCalledWith('abort_encode', { id: 'session' });
    expect(
      mocks.invoke.mock.calls.some(
        (args) => args[0] === 'write_encode_frame' || args[0] === 'finish_encode',
      ),
    ).toBe(false);
  });
  it('cleans up failed native writes and leaves the editable document unchanged', async () => {
    const doc = fixture(),
      before = doc.frames.map((frame) => [...frame.pixels]);
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'video_export_capabilities')
        return { frameDurationsMs: true, formats: ['mov', 'webm'] };
      if (command === 'begin_encode') return 'session';
      if (command === 'write_encode_frame') throw Error('Disk full');
    });
    await expect(
      exportSpriteVideo({
        doc,
        format: 'mov',
        ffmpeg: 'ffmpeg',
        signal: new AbortController().signal,
        progress: vi.fn(),
      }),
    ).rejects.toThrow('Disk full');
    expect(mocks.invoke).toHaveBeenCalledWith('abort_encode', { id: 'session' });
    expect(doc.frames.map((frame) => [...frame.pixels])).toEqual(before);
  });
});
