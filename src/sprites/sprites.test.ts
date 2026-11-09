import { describe, expect, it } from 'vitest';
import { buildAtlasPixels, atlasMetadata, planAtlas } from './atlas';
import {
  createDocument,
  deleteFrame,
  floodFill,
  frameAtTime,
  playbackOrder,
  resizeCanvas,
  sheetDefaults,
  validateDocument,
} from './model';
import { decodeProject, encodeProject } from './io';

function fixture() {
  const doc = createDocument(5, 4, 'test');
  doc.frames[0].pixels.set([230, 40, 80, 128], (1 * 5 + 2) * 4);
  doc.frames[0].pixels.set([10, 150, 30, 255], (2 * 5 + 3) * 4);
  doc.frames.push({ id: 'empty', pixels: new Uint8ClampedArray(5 * 4 * 4), duration: 240 });
  doc.tags = [{ name: 'idle', from: 0, to: 1, direction: 'pingpong' }];
  return doc;
}
describe('game atlas export', () => {
  it('reconstructs all trimmed RGBA frames exactly and keeps empty-frame timing', () => {
    const doc = fixture(),
      options = { ...sheetDefaults, columns: 2, trim: true, extrude: 1 },
      atlas = buildAtlasPixels(doc, options),
      metadata = atlasMetadata(doc, options, 'test.png');
    atlas.frames.forEach((entry, i) => {
      const restored = new Uint8ClampedArray(doc.width * doc.height * 4),
        r = entry.frame,
        b = entry.spriteSourceSize;
      for (let y = 0; y < r.h; y++)
        for (let x = 0; x < r.w; x++) {
          const from = ((r.y + y) * atlas.width + r.x + x) * 4,
            to = ((b.y + y) * doc.width + b.x + x) * 4;
          restored.set(atlas.pixels.subarray(from, from + 4), to);
        }
      expect([...restored]).toEqual([...doc.frames[i].pixels]);
    });
    expect(metadata.frames[1].duration).toBe(240);
    expect(metadata.frames[1].frame.w).toBe(1);
    expect(metadata.meta.frameTags).toEqual(doc.tags);
    expect(metadata.meta.pixelForge.pivotPixels).toEqual(doc.pivot);
  });
  it('keeps extrusion outside frame rects and leaves requested spacing transparent', () => {
    const doc = createDocument(2, 2);
    doc.frames[0].pixels.fill(255);
    doc.frames.push({ ...doc.frames[0], id: '2', pixels: doc.frames[0].pixels.slice() });
    const options = { ...sheetDefaults, columns: 2, padding: 2, margin: 1, extrude: 1 },
      atlas = buildAtlasPixels(doc, options),
      r = atlas.frames[0].frame;
    expect(atlas.pixels[((r.y - 1) * atlas.width + r.x - 1) * 4 + 3]).toBe(255);
    expect(atlas.pixels[(r.y * atlas.width + r.x + r.w + 1) * 4 + 3]).toBe(0);
    expect(atlas.frames[1].frame.x - r.x).toBe(6);
  });
  it('uses optional power-of-two dimensions and rejects oversized sheets', () => {
    const doc = fixture(),
      plan = planAtlas(doc, { ...sheetDefaults, powerOfTwo: true });
    expect(Number.isInteger(Math.log2(plan.width))).toBe(true);
    expect(Number.isInteger(Math.log2(plan.height))).toBe(true);
    expect(() => planAtlas(doc, { ...sheetDefaults, maxSize: 4 })).toThrow();
  });
});
describe('animation timing and pixel edits', () => {
  it('honors individual durations at exact boundaries and loops predictably', () => {
    const doc = fixture(),
      order = playbackOrder(undefined, 2);
    expect(frameAtTime(doc, order, 99)).toBe(0);
    expect(frameAtTime(doc, order, 100)).toBe(1);
    expect(frameAtTime(doc, order, 340)).toBe(0);
    expect(playbackOrder({ name: 'walk', from: 0, to: 3, direction: 'pingpong' }, 4)).toEqual([
      0, 1, 2, 3, 2, 1,
    ]);
  });
  it('fills only connected matching pixels and preserves other alpha', () => {
    const data = new Uint8ClampedArray([0, 0, 0, 0, 255, 0, 0, 128, 0, 0, 0, 0]);
    floodFill(data, 3, 0, 0, [1, 2, 3, 255]);
    expect([...data]).toEqual([1, 2, 3, 255, 255, 0, 0, 128, 0, 0, 0, 0]);
  });
  it('maintains tag ranges on deletion and pads without resampling', () => {
    const doc = fixture(),
      resized = resizeCanvas(doc, 6, 5);
    expect([...resized.frames[0].pixels.slice((1 * 6 + 2) * 4, (1 * 6 + 2) * 4 + 4)]).toEqual([
      230, 40, 80, 128,
    ]);
    expect(deleteFrame(doc, 0).tags[0]).toMatchObject({ from: 0, to: 0 });
    expect(() => resizeCanvas(doc, 100000, 100000)).toThrow();
  });
  it('round-trips editable project pixels, timings, tags, and pivot', () => {
    const doc = fixture(),
      restored = decodeProject(encodeProject(doc));
    validateDocument(restored);
    expect(restored.frames.map((f) => [...f.pixels])).toEqual(doc.frames.map((f) => [...f.pixels]));
    expect(restored.tags).toEqual(doc.tags);
    expect(restored.pivot).toEqual(doc.pivot);
    expect(restored.frames[1].duration).toBe(240);
  });
});
