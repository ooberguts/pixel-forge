import { parseGIF, decompressFrame, type ParsedFrame } from 'gifuct-js';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { newId, validateDocument, type SpriteDocument } from './model';

/** Reconstruct complete frames before editing: GIF patches are not standalone images. */
export function decodeGif(bytes: Uint8Array, name: string): SpriteDocument {
  if (bytes.length > 32 * 1024 * 1024) throw Error('Use a GIF smaller than 32 MB.');
  if (bytes.length < 14 || !/^GIF8[79]a$/.test(new TextDecoder().decode(bytes.subarray(0, 6))))
    throw Error('This file is not a valid GIF.');
  const gif = parseGIF(new Uint8Array(bytes).buffer);
  const { width, height } = gif.lsd;
  const images = gif.frames.filter((frame) => 'image' in frame);
  if (!images.length) throw Error('This GIF has no image frames.');
  if (!width || !height || width > 512 || height > 512)
    throw Error(`This GIF is ${width} × ${height} px. GIF editing supports up to 512 × 512 px.`);
  if (images.length > 256 || width * height * images.length > 16_000_000)
    throw Error(
      'GIF editing supports up to 256 frames and 16 million total pixels. Use a shorter or smaller GIF.',
    );
  // Bound patches before decompression, including malformed out-of-canvas frames.
  for (const frame of images) {
    const rect = frame.image.descriptor;
    if (
      !rect.width ||
      !rect.height ||
      rect.left + rect.width > width ||
      rect.top + rect.height > height
    )
      throw Error('A GIF frame extends outside its canvas.');
    if ((frame.gce?.delay ?? 0) > 6000)
      throw Error('A GIF frame lasts longer than the 60-second editing limit.');
  }
  let gifRepeat = -1;
  for (const frame of gif.frames) {
    if ('application' in frame && ['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(frame.application.id)) {
      const data = frame.application.blocks;
      if (data.length >= 3 && data[0] === 1) gifRepeat = data[1] | (data[2] << 8);
    }
  }
  const background = gif.gct?.[gif.lsd.backgroundColorIndex];
  const backgroundRGBA = background ? [...background, 255] : [0, 0, 0, 0];
  const pixels = new Uint8ClampedArray(width * height * 4);
  const fill = (rect: ParsedFrame['dims'], color: number[]) => {
    for (let y = rect.top; y < rect.top + rect.height; y++)
      for (let x = rect.left; x < rect.left + rect.width; x++)
        pixels.set(color, (y * width + x) * 4);
  };
  if (!images[0].gce?.extras.transparentColorGiven)
    fill({ left: 0, top: 0, width, height }, backgroundRGBA);
  let previous: ParsedFrame | undefined;
  let restored: Uint8ClampedArray | undefined;
  const frames = images.map((image) => {
    if (previous?.disposalType === 2)
      fill(previous.dims, previous.transparentIndex === undefined ? backgroundRGBA : [0, 0, 0, 0]);
    else if (previous?.disposalType === 3 && restored) pixels.set(restored);
    const frame = decompressFrame(image, gif.gct, true);
    restored = frame.disposalType === 3 ? pixels.slice() : undefined;
    for (let y = 0; y < frame.dims.height; y++) {
      for (let x = 0; x < frame.dims.width; x++) {
        const source = (y * frame.dims.width + x) * 4;
        if (frame.patch[source + 3]) {
          const target = ((frame.dims.top + y) * width + frame.dims.left + x) * 4;
          pixels.set(frame.patch.subarray(source, source + 4), target);
        }
      }
    }
    previous = frame;
    return { id: newId(), pixels: pixels.slice(), duration: frame.delay || 100 };
  });
  const doc: SpriteDocument = {
    name: name.replace(/\.[^.]+$/, '').slice(0, 100),
    width,
    height,
    gifRepeat,
    pivot: { x: Math.floor(width / 2), y: height },
    frames,
    tags:
      frames.length > 1
        ? [{ name: 'animation', from: 0, to: frames.length - 1, direction: 'forward' }]
        : [],
  };
  validateDocument(doc);
  return doc;
}

function indexedFrame(pixels: Uint8ClampedArray) {
  // Preserve exact RGB values for pixel-art palettes; reserve index zero for transparency.
  let palette: number[][] = [[0, 0, 0]];
  const colors = new Map<number, number>();
  let index: Uint8Array = new Uint8Array(pixels.length / 4);
  let needsQuantization = false;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
    let color = colors.get(key);
    if (color === undefined) {
      if (palette.length === 256) {
        needsQuantization = true;
        break;
      }
      color = palette.length;
      colors.set(key, color);
      palette.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
    }
    index[i / 4] = color;
  }
  if (needsQuantization) {
    const opaque = pixels.slice();
    for (let i = 0; i < opaque.length; i += 4) if (opaque[i + 3] < 128) opaque.fill(0, i, i + 4);
    const reduced = quantize(opaque, 255);
    index = applyPalette(opaque, reduced);
    for (let i = 0; i < index.length; i++) index[i] = pixels[i * 4 + 3] < 128 ? 0 : index[i] + 1;
    palette = [[0, 0, 0], ...reduced];
  }
  if (palette.length === 1) palette.push([0, 0, 0]);
  return { index, palette };
}

export async function encodeGif(
  doc: SpriteDocument,
  order = doc.frames.map((_, i) => i),
  progress?: (label: string) => void,
) {
  validateDocument(doc);
  if (
    !order.length ||
    order.length > 512 ||
    order.some((i) => !Number.isInteger(i) || !doc.frames[i])
  )
    throw Error('Choose a valid animation range for GIF export.');
  const gif = GIFEncoder();
  let elapsed = 0,
    encodedTime = 0;
  for (let i = 0; i < order.length; i++) {
    const frame = doc.frames[order[i]];
    const { index, palette } = indexedFrame(frame.pixels);
    elapsed += frame.duration;
    // Round cumulative boundaries to GIF's 10 ms ticks, avoiding frame-by-frame drift.
    const delay = Math.max(10, Math.round(elapsed / 10) * 10 - encodedTime);
    encodedTime += delay;
    gif.writeFrame(index, doc.width, doc.height, {
      palette,
      delay,
      repeat: doc.gifRepeat ?? 0,
      transparent: true,
      transparentIndex: 0,
      dispose: 2,
    });
    progress?.(`Encoding GIF frame ${i + 1} of ${order.length}…`);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  gif.finish();
  return gif.bytes();
}
