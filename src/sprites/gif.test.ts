import { describe, expect, it } from 'vitest';
import { gifFixture } from '../../tests/helpers/gif-fixture';
import { decodeGif, encodeGif } from './gif';
import { createDocument } from './model';
import { decodeProject, encodeProject } from './io';

const clear = [0, 0, 0, 0],
  red = [255, 0, 0, 255],
  green = [0, 255, 0, 255],
  blue = [0, 0, 255, 255];
describe('editable GIF frames', () => {
  it('composites offset patches and honors keep, background and previous disposal', () => {
    const doc = decodeGif(
      gifFixture(
        [
          { colors: [1, 1, 1], delay: 18 },
          { colors: [2], dispose: 2, delay: 7 },
          { colors: [3], left: 1, dispose: 3, delay: 25 },
          { colors: [0, 0, 2], delay: 0 },
        ],
        3,
        4,
      ),
      'walk.gif',
    );
    expect(doc.frames.map((f) => [...f.pixels])).toEqual([
      [...red, ...red, ...red],
      [...green, ...red, ...red],
      [...clear, ...blue, ...red],
      [...clear, ...red, ...green],
    ]);
    expect(doc.frames.map((f) => f.duration)).toEqual([180, 70, 250, 100]);
    expect(doc.gifRepeat).toBe(4);
    expect(decodeProject(encodeProject(doc)).gifRepeat).toBe(4);
    expect(doc.tags).toEqual([{ name: 'animation', from: 0, to: 3, direction: 'forward' }]);
  });
  it('restores opaque background when a disposed frame has no transparency', () => {
    const doc = decodeGif(
      gifFixture([
        { colors: [1], dispose: 2, transparent: false },
        { colors: [2], left: 2 },
      ]),
      'once.gif',
    );
    expect([...doc.frames[1].pixels]).toEqual([0, 0, 0, 255, 0, 0, 0, 255, ...green]);
    expect(doc.gifRepeat).toBe(-1);
  });
  it('round-trips moving transparent pixels without trails and leaves source RGBA untouched', async () => {
    const doc = createDocument(3, 1);
    doc.gifRepeat = -1;
    doc.frames[0].pixels.set([...red, 40, 50, 60, 127, 70, 80, 90, 128]);
    doc.frames.push({
      id: 'next',
      duration: 250,
      pixels: new Uint8ClampedArray([...clear, ...green, ...clear]),
    });
    const original = doc.frames.map((f) => [...f.pixels]);
    const result = decodeGif(await encodeGif(doc), 'out.gif');
    expect(result.frames.map((f) => [...f.pixels])).toEqual([
      [...red, ...clear, 70, 80, 90, 255],
      [...clear, ...green, ...clear],
    ]);
    expect(result.frames.map((f) => f.duration)).toEqual([100, 250]);
    expect(result.gifRepeat).toBe(-1);
    expect(doc.frames.map((f) => [...f.pixels])).toEqual(original);
  });
  it('rounds cumulative timing without drift and follows the chosen animation order', async () => {
    const doc = createDocument(1, 1);
    doc.frames = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      duration: 83,
      pixels: new Uint8ClampedArray([i, 10, 20, 255]),
    }));
    const order = doc.frames.map((_, i) => 11 - i);
    const result = decodeGif(await encodeGif(doc, order), 'reverse.gif');
    expect(result.frames.map((f) => f.pixels[0])).toEqual(order);
    expect(result.frames.reduce((sum, f) => sum + f.duration, 0)).toBe(1000);
    expect(result.gifRepeat).toBe(0);
    await expect(encodeGif(doc, [12])).rejects.toThrow('valid animation range');
  });
  it('quantizes large palettes and preserves fully transparent frames', async () => {
    const doc = createDocument(32, 16);
    for (let i = 0; i < 512; i++) doc.frames[0].pixels.set([i % 256, i >> 1, 100, 255], i * 4);
    doc.frames.push({ id: 'blank', duration: 100, pixels: new Uint8ClampedArray(32 * 16 * 4) });
    const result = decodeGif(await encodeGif(doc), 'colors.gif');
    expect(result.frames[0].pixels.filter((_, i) => i % 4 === 3).every((a) => a === 255)).toBe(
      true,
    );
    expect(result.frames[1].pixels.every((v) => v === 0)).toBe(true);
  });
  it('rejects invalid files and over-limit dimensions, patches, timing and frame counts', () => {
    expect(() => decodeGif(new Uint8Array(30), 'bad')).toThrow('valid GIF');
    expect(() => decodeGif(gifFixture([{ colors: [1] }], 513), 'large')).toThrow('512');
    expect(() => decodeGif(gifFixture([{ colors: [1], left: 3 }]), 'patch')).toThrow('outside');
    expect(() => decodeGif(gifFixture([{ colors: [1], delay: 6001 }]), 'slow')).toThrow(
      '60-second',
    );
    expect(() =>
      decodeGif(gifFixture(Array.from({ length: 257 }, () => ({ colors: [1] }))), 'long'),
    ).toThrow('256 frames');
  });
});
