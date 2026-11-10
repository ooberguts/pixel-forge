import { describe, it, expect } from 'vitest';
import { animationTimeline, adjacentAnimationTime } from './animationTiming';
import { createDocument } from './sprites/model';
const doc = createDocument(1, 1);
doc.frames = [90, 170, 250].map((duration, i) => ({ ...doc.frames[0], id: String(i), duration }));
describe('original animation timing', () => {
  it('retains every variable duration and the exact total', () => {
    expect(animationTimeline(doc, 0, 0.51)).toEqual([
      { index: 0, time: 0, duration: 90 },
      { index: 1, time: 0.09, duration: 170 },
      { index: 2, time: 0.26, duration: 250 },
    ]);
  });
  it('clips only the intersecting frame intervals, including an exact boundary', () => {
    expect(animationTimeline(doc, 0.09, 0.51).map((f) => f.duration)).toEqual([170, 250]);
    expect(animationTimeline(doc, 0.05, 0.3)).toEqual([
      { index: 0, time: 0.05, duration: 40 },
      { index: 1, time: 0.09, duration: 170 },
      { index: 2, time: 0.26, duration: 40 },
    ]);
    expect(doc.frames.map((f) => f.duration)).toEqual([90, 170, 250]);
  });
  it('rejects unrepresentable short trimmed frames rather than lengthening the animation', () => {
    expect(() => animationTimeline(doc, 0.085, 0.51)).toThrow('shorter than 10 ms');
  });
  it.each([
    [-1, 0.5],
    [0, 0.52],
    [0.2, 0.1],
    [0, NaN],
  ])('rejects an invalid range %s to %s', (start, end) => {
    expect(() => animationTimeline(doc, start, end)).toThrow('trim range');
  });
});

describe('animation frame stepping', () => {
  it('uses variable-duration frame boundaries rather than a video sampling rate', () => {
    expect(adjacentAnimationTime(doc, 0, 1, 0, 0.51)).toBe(0.09);
    expect(adjacentAnimationTime(doc, 0.09, 1, 0, 0.51)).toBe(0.26);
    expect(adjacentAnimationTime(doc, 0.26, -1, 0, 0.51)).toBe(0.09);
    expect(adjacentAnimationTime(doc, 0.2, -1, 0, 0.51)).toBe(0.09);
  });
  it('clamps at the first and last visible frames and respects partial trim', () => {
    expect(adjacentAnimationTime(doc, 0.05, -1, 0.05, 0.3)).toBe(0.05);
    expect(adjacentAnimationTime(doc, 0.26, 1, 0.05, 0.3)).toBe(0.26);
    expect(adjacentAnimationTime(doc, 0.09, -1, 0.05, 0.3)).toBe(0.05);
    expect(adjacentAnimationTime(doc, 0.05, 1, 0.05, 0.08)).toBe(0.05);
  });
});
