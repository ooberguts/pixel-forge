import { describe, expect, it } from 'vitest';
import { adaptivePalette, defaults, parsePalette, prepare, processPixels } from './engine';
import { anchorAt, emptyStabilization, frameTransform, upsertKeyframe } from './stabilization';
import { frameTimes } from './export';

describe('RGBA conversion', () => {
  it('preserves partial alpha through color reduction and dithering', () => {
    const pixels = new Uint8ClampedArray([255, 80, 80, 0, 120, 145, 200, 73, 17, 240, 20, 255]);
    for (const dither of ['none', 'bayer', 'floyd'] as const) {
      const result = processPixels(pixels, 3, { ...defaults, dither });
      expect([result.data[3], result.data[7], result.data[11]]).toEqual([0, 73, 255]);
      expect([...result.data.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    }
  });
  it('never learns invisible RGB as a palette color', () => {
    const palette = adaptivePalette(new Uint8ClampedArray([0, 255, 0, 0, 255, 0, 0, 255]), 16);
    expect(palette).toEqual([[255, 0, 0]]);
  });
  it('keys before grading and feathers partial alpha without inventing opacity', () => {
    const settings = {
      ...defaults,
      alpha: 'key' as const,
      keyTolerance: 10,
      keySoftness: 40,
      brightness: 90,
    };
    const result = prepare(
      new Uint8ClampedArray([0, 255, 0, 255, 30, 255, 0, 128, 255, 0, 0, 255]),
      settings,
    );
    expect(result[3]).toBe(0);
    expect(result[7]).toBe(64);
    expect(result[11]).toBe(255);
  });
  it('higher key strength removes a wider color range', () => {
    const pixel = new Uint8ClampedArray([100, 255, 0, 255]);
    expect(prepare(pixel, { ...defaults, alpha: 'key', keyTolerance: 20, keySoftness: 0 })[3]).toBe(
      255,
    );
    expect(
      prepare(pixel, { ...defaults, alpha: 'key', keyTolerance: 110, keySoftness: 0 })[3],
    ).toBe(0);
  });
  it('uses a locked palette for every frame and leaves alpha intact', () => {
    const settings = { ...defaults, palette: 'adaptive' as const };
    const palette: [[number, number, number], [number, number, number]] = [
      [0, 0, 0],
      [255, 255, 255],
    ];
    for (const value of [10, 90, 160, 240]) {
      const { data } = processPixels(
        new Uint8ClampedArray([value, value, value, 111]),
        1,
        settings,
        palette,
      );
      expect([0, 255]).toContain(data[0]);
      expect(data[3]).toBe(111);
    }
  });
  it('supports custom palettes and removes duplicate colors', () =>
    expect(parsePalette('#ffffff #ff0000 #FFFFFF bad')).toEqual([
      [255, 255, 255],
      [255, 0, 0],
    ]));
});
describe('stationary marker stabilization', () => {
  const keys = [
    { time: 0, x: 0.2, y: 0.3 },
    { time: 2, x: 0.6, y: 0.7 },
  ];
  it('interpolates source anchor points and holds endpoints', () => {
    expect(anchorAt(keys, -2)).toEqual(keys[0]);
    expect(anchorAt(keys, 1)).toEqual({ x: 0.4, y: 0.5 });
    expect(anchorAt(keys, 4)).toEqual(keys[1]);
  });
  it('keeps the source feature at the same target including zoom', () => {
    const stabilization = { enabled: true, target: { x: 0.4, y: 0.6 }, keyframes: keys, zoom: 1.5 };
    for (const time of [0, 0.25, 1, 1.75, 2]) {
      const source = anchorAt(keys, time),
        transform = frameTransform(stabilization, time);
      expect(source.x * transform.scale + transform.x).toBeCloseTo(0.4);
      expect(source.y * transform.scale + transform.y).toBeCloseTo(0.6);
    }
    expect(frameTransform(emptyStabilization, 1)).toEqual({ x: 0, y: 0, scale: 1 });
  });
  it('replaces a marker on the same frame and sorts the track', () => {
    expect(upsertKeyframe(keys, { time: 0.01, x: 0.5, y: 0.5 }, 12)).toEqual([
      { time: 0.01, x: 0.5, y: 0.5 },
      keys[1],
    ]);
  });
});
describe('video sampling', () => {
  it('samples a half-open trim range without a duplicated last frame', () => {
    expect(frameTimes(1, 2, 12)).toHaveLength(12);
    expect(frameTimes(1, 2, 12).at(-1)).toBeCloseTo(1 + 11 / 12);
    expect(frameTimes(0, 0.1, 30)).toHaveLength(3);
  });
  it('rejects unsafe or unbounded jobs', () => {
    expect(() => frameTimes(2, 1, 12)).toThrow();
    expect(() => frameTimes(0, 999, 30)).toThrow();
    expect(() => frameTimes(0, 1, NaN)).toThrow();
    expect(() => frameTimes(-1, 1, 12)).toThrow();
  });
});
