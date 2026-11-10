import type { RGB, Settings } from '../engine';
import { frameTimes, throwIfCancelled, type Progress } from '../export';
import {
  disposeMedia,
  loadMedia,
  mediaFromAnimation,
  renderMedia,
  seekMedia,
  type Media,
} from '../media';
import { animationTimeline } from '../animationTiming';
import type { Stabilization } from '../stabilization';
import { newId, validateDocument, type SpriteDocument } from './model';

export function documentFromCanvas(canvas: HTMLCanvasElement, name: string): SpriteDocument {
  const doc: SpriteDocument = {
    name: name.replace(/\.[^.]+$/, '').slice(0, 100),
    width: canvas.width,
    height: canvas.height,
    pivot: { x: Math.floor(canvas.width / 2), y: canvas.height },
    tags: [],
    frames: [
      {
        id: newId(),
        duration: 100,
        pixels: canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data,
      },
    ],
  };
  validateDocument(doc);
  return doc;
}
export async function captureClip(
  media: Media,
  settings: Settings,
  palette: RGB[],
  stabilization: Stabilization,
  start: number,
  end: number,
  fps: number,
  signal: AbortSignal,
  progress: (p: Progress) => void,
): Promise<SpriteDocument> {
  const original = media.animation ? animationTimeline(media.animation, start, end) : undefined;
  const times = original ? original.map((frame) => frame.time) : frameTimes(start, end, fps),
    height = Math.max(1, Math.round((settings.width * media.height) / media.width));
  if (
    times.length > 256 ||
    settings.width * height * times.length > 16_000_000 ||
    settings.width > 512 ||
    height > 512
  )
    throw Error(
      'Sprite editing supports up to 256 frames, 512 × 512 per frame, and 16 million total pixels. Reduce resolution, FPS, or trim duration.',
    );
  if (!media.url && !media.animation) throw Error('Open an animation first.');
  throwIfCancelled(signal);
  const decoder = media.animation
    ? mediaFromAnimation(media.animation, media.name)
    : await (async () => {
        const blob = await (await fetch(media.url!)).blob();
        return loadMedia(new File([blob], media.name, { type: blob.type }));
      })();
  const doc: SpriteDocument = {
    name: media.name.replace(/\.[^.]+$/, '').slice(0, 100),
    gifRepeat: media.animation?.gifRepeat,
    width: settings.width,
    height,
    pivot: { x: Math.floor(settings.width / 2), y: height },
    frames: [],
    tags: [{ name: 'animation', from: 0, to: times.length - 1, direction: 'forward' }],
  };
  try {
    for (let i = 0; i < times.length; i++) {
      throwIfCancelled(signal);
      await seekMedia(decoder, times[i]);
      throwIfCancelled(signal);
      const { canvas } = renderMedia(decoder, settings, palette, stabilization, times[i], true);
      const duration =
        original?.[i].duration ??
        Math.max(
          10,
          Math.round(((times[i + 1] ?? end) - start) * 1000) -
            Math.round((times[i] - start) * 1000),
        );
      doc.frames.push({
        id: newId(),
        duration,
        pixels: canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data,
      });
      progress({
        fraction: (i + 1) / times.length,
        label: `Preparing frame ${i + 1} of ${times.length}`,
      });
    }
    if (media.animation && original) {
      const source = media.animation,
        first = original[0].index,
        last = original[original.length - 1].index;
      doc.pivot = {
        x: (source.pivot.x * doc.width) / source.width,
        y: (source.pivot.y * doc.height) / source.height,
      };
      doc.tags = source.tags
        .filter((tag) => tag.to >= first && tag.from <= last)
        .map((tag) => ({
          ...tag,
          from: Math.max(first, tag.from) - first,
          to: Math.min(last, tag.to) - first,
        }));
    }
    throwIfCancelled(signal);
    validateDocument(doc);
    return doc;
  } finally {
    disposeMedia(decoder);
  }
}
