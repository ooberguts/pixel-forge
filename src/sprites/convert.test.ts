import { describe, expect, it, vi } from 'vitest';
import { defaults } from '../engine';
import { conversionSize, convertSpriteFrames, renderSpriteFrame } from './convert';
import { createDocument } from './model';

describe('frame conversion output limits', () => {
  it('rounds the aspect ratio and keeps a minimum one-pixel height', () => {
    expect(conversionSize(createDocument(7, 3), { ...defaults, width: 10 })).toEqual({
      width: 10,
      height: 4,
    });
    expect(conversionSize(createDocument(512, 1), { ...defaults, width: 1 })).toEqual({
      width: 1,
      height: 1,
    });
  });

  it('rejects thin/tall output before the preview allocates any canvas', () => {
    const doc = createDocument(1, 512),
      settings = { ...defaults, width: 2 };
    expect(() => conversionSize(doc, settings)).toThrow('512 × 512');
    // This Node test has no document/canvas. The same useful size error must precede rendering.
    expect(() => renderSpriteFrame(doc, 0, settings)).toThrow('512 × 512');
  });

  it('checks the whole animation budget, accepting the exact limit', () => {
    const doc = createDocument(32, 32);
    doc.frames = Array.from({ length: 64 }, (_, index) => ({
      ...doc.frames[0],
      id: String(index),
    }));
    expect(conversionSize(doc, { ...defaults, width: 500 })).toEqual({ width: 500, height: 500 });
    expect(() => conversionSize(doc, { ...defaults, width: 501 })).toThrow('16 million');
    expect(() => renderSpriteFrame(doc, 0, { ...defaults, width: 501 })).toThrow('16 million');
  });

  it.each([0, -1, 1.5, 513, NaN, Infinity])('rejects invalid pixel width %s', (width) => {
    expect(() => conversionSize(createDocument(), { ...defaults, width })).toThrow('whole number');
  });

  it('rejects an invalid batch before reporting progress or rendering frames', async () => {
    const progress = vi.fn();
    await expect(
      convertSpriteFrames(
        createDocument(1, 512),
        { ...defaults, width: 2 },
        new AbortController().signal,
        progress,
      ),
    ).rejects.toThrow('512 × 512');
    expect(progress).not.toHaveBeenCalled();
  });
});
