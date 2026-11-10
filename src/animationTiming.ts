import type { SpriteDocument } from './sprites/model';

/** Intersect a trim with original frame intervals; never silently resample animation timing. */
export function animationTimeline(doc: SpriteDocument, start: number, end: number) {
  const total = doc.frames.reduce((sum, frame) => sum + frame.duration, 0);
  const from = Math.round(start * 1000),
    to = Math.round(end * 1000);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to > total)
    throw Error('Choose a trim range inside the animation.');
  let cursor = 0;
  const frames: { index: number; time: number; duration: number }[] = [];
  doc.frames.forEach((frame, index) => {
    const left = Math.max(cursor, from),
      right = Math.min(cursor + frame.duration, to);
    if (right > left) {
      if (right - left < 10)
        throw Error(
          'A trimmed frame is shorter than 10 ms. Move the trim point to keep at least 10 ms.',
        );
      frames.push({ index, time: left / 1000, duration: right - left });
    }
    cursor += frame.duration;
  });
  return frames;
}

/** Step to a real frame boundary, including a partially trimmed first frame. */
export function adjacentAnimationTime(
  doc: SpriteDocument,
  time: number,
  direction: -1 | 1,
  start: number,
  end: number,
) {
  const boundaries = [start];
  let cursor = 0;
  for (const frame of doc.frames) {
    const boundary = cursor / 1000;
    if (boundary > start && boundary < end) boundaries.push(boundary);
    cursor += frame.duration;
  }
  return direction === 1
    ? (boundaries.find((boundary) => boundary > time + 0.000001) ?? boundaries.at(-1)!)
    : ([...boundaries].reverse().find((boundary) => boundary < time - 0.000001) ?? start);
}
