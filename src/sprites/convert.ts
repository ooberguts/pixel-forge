import { defaults, prepare, type RGB, type Settings } from '../engine';
import { renderMedia } from '../media';
import { frameCanvas } from './io';
import { validateDocument, type SpriteDocument } from './model';

/** Check the complete output budget before preparing pixels or allocating a preview canvas. */
export function conversionSize(doc: SpriteDocument, settings: Settings) {
  const width = settings.width;
  if (!Number.isInteger(width) || width < 1 || width > 512)
    throw Error('Pixel width must be a whole number from 1 to 512.');
  const height = Math.max(1, Math.round((width * doc.height) / doc.width));
  if (!Number.isInteger(height) || height > 512 || width * height * doc.frames.length > 16_000_000)
    throw Error('Choose a size up to 512 × 512 px and 16 million total frame pixels.');
  return { width, height };
}

export function renderSpriteFrame(
  doc: SpriteDocument,
  frame: number,
  settings: Settings,
  palette?: RGB[],
) {
  conversionSize(doc, settings);
  const source = doc.frames[frame];
  // Remove the background before resampling so green pixels cannot bleed into the edge.
  const keyed =
    settings.alpha === 'key'
      ? prepare(source.pixels, {
          ...defaults,
          alpha: 'key',
          keyColor: settings.keyColor,
          keyTolerance: settings.keyTolerance,
          keySoftness: settings.keySoftness,
        })
      : source.pixels;
  const canvas = frameCanvas(keyed, doc.width, doc.height);
  return renderMedia(
    {
      name: doc.name,
      kind: 'image',
      source: canvas,
      width: doc.width,
      height: doc.height,
      duration: 0,
    },
    settings.alpha === 'key' ? { ...settings, alpha: 'preserve' } : settings,
    palette,
  );
}

export async function convertSpriteFrames(
  doc: SpriteDocument,
  settings: Settings,
  signal: AbortSignal,
  progress: (done: number) => void,
) {
  const { width, height } = conversionSize(doc, settings);
  const frames: SpriteDocument['frames'] = [];
  let palette: RGB[] | undefined;
  for (let i = 0; i < doc.frames.length; i++) {
    signal.throwIfAborted();
    const rendered = renderSpriteFrame(doc, i, settings, palette);
    if (settings.palette === 'adaptive' && i === 0) palette = rendered.palette;
    frames.push({
      ...doc.frames[i],
      pixels: rendered.canvas.getContext('2d')!.getImageData(0, 0, width, height).data,
    });
    progress(i + 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  const result = {
    ...doc,
    width,
    height,
    frames,
    pivot: {
      x: (doc.pivot.x * width) / doc.width,
      y: (doc.pivot.y * height) / doc.height,
    },
  };
  validateDocument(result);
  return result;
}
