import { APP_VERSION } from '../version';
import { validateDocument, type SpriteDocument, type SheetOptions } from './model';
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export function visibleBounds(pixels: Uint8ClampedArray, width: number, height: number): Rect {
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (pixels[(y * width + x) * 4 + 3]) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  // Empty frames retain their timing and have a valid transparent 1×1 atlas region.
  return right < 0
    ? { x: 0, y: 0, w: 1, h: 1 }
    : { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}
const powerOfTwo = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
export function planAtlas(doc: SpriteDocument, options: SheetOptions) {
  validateDocument(doc);
  for (const [key, value] of Object.entries(options))
    if (typeof value === 'number' && (!Number.isInteger(value) || value < 0))
      throw Error('Atlas options must be nonnegative integers: ' + key);
  if (
    options.columns < 1 ||
    options.maxSize < 1 ||
    options.extrude > 4 ||
    options.padding > 32 ||
    options.margin > 32
  )
    throw Error('Invalid atlas size or padding.');
  const columns = Math.min(doc.frames.length, options.columns),
    rows = Math.ceil(doc.frames.length / columns);
  const cellW = doc.width + 2 * options.extrude,
    cellH = doc.height + 2 * options.extrude;
  let width = 2 * options.margin + columns * cellW + (columns - 1) * options.padding;
  let height = 2 * options.margin + rows * cellH + (rows - 1) * options.padding;
  if (options.powerOfTwo) {
    width = powerOfTwo(width);
    height = powerOfTwo(height);
  }
  if (width > options.maxSize || height > options.maxSize || width * height > 32_000_000)
    throw Error(
      `Atlas would be ${width} × ${height}. Change columns or reduce frame size/count (maximum ${options.maxSize} px per side).`,
    );
  const frames = doc.frames.map((frame, index) => {
    const bounds = options.trim
      ? visibleBounds(frame.pixels, doc.width, doc.height)
      : { x: 0, y: 0, w: doc.width, h: doc.height };
    const rect = {
      x: options.margin + (index % columns) * (cellW + options.padding) + options.extrude,
      y: options.margin + Math.floor(index / columns) * (cellH + options.padding) + options.extrude,
      w: bounds.w,
      h: bounds.h,
    };
    return {
      filename: `${doc.name}-${String(index).padStart(4, '0')}`,
      frame: rect,
      rotated: false,
      trimmed: bounds.w !== doc.width || bounds.h !== doc.height,
      spriteSourceSize: bounds,
      sourceSize: { w: doc.width, h: doc.height },
      duration: frame.duration,
      pivot: { x: doc.pivot.x / doc.width, y: doc.pivot.y / doc.height },
    };
  });
  return { width, height, columns, rows, cellW, cellH, frames };
}
export function atlasMetadata(doc: SpriteDocument, options: SheetOptions, image: string) {
  const plan = planAtlas(doc, options);
  return {
    frames: plan.frames,
    meta: {
      app: 'Pixel Forge',
      version: APP_VERSION,
      image,
      format: 'RGBA8888',
      size: { w: plan.width, h: plan.height },
      scale: '1',
      frameTags: doc.tags.map((tag) => ({ ...tag })),
      slices: [
        {
          name: 'origin',
          color: '#c7ec95ff',
          keys: [
            { frame: 0, bounds: { x: 0, y: 0, w: doc.width, h: doc.height }, pivot: doc.pivot },
          ],
        },
      ],
      pixelForge: {
        schemaVersion: 1,
        origin: 'top-left',
        frameIndices: 'zero-based-inclusive',
        pivotPixels: doc.pivot,
        pivotSpace: 'untrimmed-source-canvas',
        alpha: 'straight RGBA',
        sampling: 'nearest',
        mipmaps: false,
        rotation: false,
        layout: {
          ...options,
          columns: plan.columns,
          rows: plan.rows,
          cellWidth: plan.cellW,
          cellHeight: plan.cellH,
        },
        looping: 'per-animation direction; repeat by default',
      },
    },
  };
}
export function buildAtlasPixels(doc: SpriteDocument, options: SheetOptions) {
  const plan = planAtlas(doc, options),
    pixels = new Uint8ClampedArray(plan.width * plan.height * 4);
  plan.frames.forEach((entry, index) => {
    const source = doc.frames[index].pixels,
      r = entry.frame,
      b = entry.spriteSourceSize,
      e = options.extrude;
    for (let y = -e; y < r.h + e; y++)
      for (let x = -e; x < r.w + e; x++) {
        const sx = b.x + Math.max(0, Math.min(r.w - 1, x)),
          sy = b.y + Math.max(0, Math.min(r.h - 1, y));
        const from = (sy * doc.width + sx) * 4,
          to = ((r.y + y) * plan.width + r.x + x) * 4;
        pixels.set(source.subarray(from, from + 4), to);
      }
  });
  return { ...plan, pixels };
}
