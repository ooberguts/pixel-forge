import type { RGB, Settings } from '../engine';
import { frameTimes, type Progress } from '../export';
import { disposeMedia, loadMedia, renderMedia, seekVideo, type Media } from '../media';
import type { Stabilization } from '../stabilization';
import { newId, validateDocument, type SpriteDocument } from './model';

export function documentFromCanvas(canvas: HTMLCanvasElement, name: string): SpriteDocument {
  const doc: SpriteDocument = {
    name: name.replace(/\.[^.]+$/, ''),
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
  const times = frameTimes(start, end, fps),
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
  if (!media.url) throw Error('Open a video first.');
  const blob = await (await fetch(media.url)).blob();
  signal.throwIfAborted();
  const decoder = await loadMedia(new File([blob], media.name, { type: blob.type }));
  const doc: SpriteDocument = {
    name: media.name.replace(/\.[^.]+$/, ''),
    width: settings.width,
    height,
    pivot: { x: Math.floor(settings.width / 2), y: height },
    frames: [],
    tags: [{ name: 'animation', from: 0, to: times.length - 1, direction: 'forward' }],
  };
  try {
    for (let i = 0; i < times.length; i++) {
      signal.throwIfAborted();
      await seekVideo(decoder.source as HTMLVideoElement, times[i]);
      const { canvas } = renderMedia(decoder, settings, palette, stabilization, times[i], true);
      const duration = Math.max(
        10,
        Math.round(((times[i + 1] ?? end) - start) * 1000) - Math.round((times[i] - start) * 1000),
      );
      doc.frames.push({
        id: newId(),
        duration,
        pixels: canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data,
      });
      progress({
        fraction: (i + 1) / times.length,
        label: `Preparing sprite frame ${i + 1} of ${times.length}`,
      });
    }
    validateDocument(doc);
    return doc;
  } finally {
    disposeMedia(decoder);
  }
}
