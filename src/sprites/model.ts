export interface SpriteFrame {
  id: string;
  pixels: Uint8ClampedArray;
  duration: number;
}
export interface AnimationTag {
  name: string;
  from: number;
  to: number;
  direction: 'forward' | 'reverse' | 'pingpong';
}
export interface SpriteDocument {
  name: string;
  /** GIF repeat count: -1 once, 0 forever, positive values repeat after the first play. */
  gifRepeat?: number;
  width: number;
  height: number;
  frames: SpriteFrame[];
  tags: AnimationTag[];
  pivot: { x: number; y: number };
}
export interface SheetOptions {
  columns: number;
  padding: number;
  margin: number;
  extrude: number;
  trim: boolean;
  powerOfTwo: boolean;
  maxSize: number;
}
export const sheetDefaults: SheetOptions = {
  columns: 8,
  padding: 2,
  margin: 1,
  extrude: 0,
  trim: false,
  powerOfTwo: false,
  maxSize: 4096,
};
export const newId = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) =>
    v.toString(16).padStart(2, '0'),
  ).join('');
};
export function validateDocument(doc: SpriteDocument) {
  if (
    doc.gifRepeat !== undefined &&
    (!Number.isInteger(doc.gifRepeat) || doc.gifRepeat < -1 || doc.gifRepeat > 65535)
  )
    throw Error('Invalid GIF repeat count.');
  if (
    !Number.isInteger(doc.width) ||
    !Number.isInteger(doc.height) ||
    doc.width < 1 ||
    doc.height < 1 ||
    doc.width > 512 ||
    doc.height > 512
  )
    throw Error('Sprite dimensions must be 1–512 pixels.');
  if (
    !doc.frames.length ||
    doc.frames.length > 256 ||
    doc.width * doc.height * doc.frames.length > 16_000_000
  )
    throw Error('Use up to 256 frames and 16 million total frame pixels.');
  for (const frame of doc.frames)
    if (
      frame.pixels.length !== doc.width * doc.height * 4 ||
      !Number.isFinite(frame.duration) ||
      frame.duration < 10 ||
      frame.duration > 60000
    )
      throw Error('Invalid frame data or duration (10–60,000 ms).');
  if (
    !Number.isFinite(doc.pivot.x) ||
    !Number.isFinite(doc.pivot.y) ||
    doc.pivot.x < 0 ||
    doc.pivot.y < 0 ||
    doc.pivot.x > doc.width ||
    doc.pivot.y > doc.height
  )
    throw Error('Pivot must be inside the source canvas bounds.');
  if (typeof doc.name !== 'string' || doc.name.length > 100) throw Error('Invalid sprite name.');
  const names = new Set<string>();
  for (const tag of doc.tags) {
    if (
      !tag.name.trim() ||
      tag.name.length > 60 ||
      names.has(tag.name) ||
      !Number.isInteger(tag.from) ||
      !Number.isInteger(tag.to) ||
      tag.from < 0 ||
      tag.to >= doc.frames.length ||
      tag.to < tag.from ||
      !['forward', 'reverse', 'pingpong'].includes(tag.direction)
    )
      throw Error('Animation names must be unique and their frame ranges must be valid.');
    names.add(tag.name);
  }
}
export function createDocument(width = 32, height = 32, name = 'sprite'): SpriteDocument {
  return {
    name,
    width,
    height,
    pivot: { x: Math.floor(width / 2), y: height },
    frames: [{ id: newId(), pixels: new Uint8ClampedArray(width * height * 4), duration: 100 }],
    tags: [],
  };
}
export function pixelLine(x0: number, y0: number, x1: number, y1: number) {
  const points: { x: number; y: number }[] = [];
  const dx = Math.abs(x1 - x0),
    sx = x0 < x1 ? 1 : -1,
    dy = -Math.abs(y1 - y0),
    sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    points.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e = 2 * err;
    if (e >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return points;
}
export function floodFill(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  color: number[],
) {
  const height = data.length / 4 / width,
    offset = (y * width + x) * 4,
    target = [...data.slice(offset, offset + 4)];
  if (target.every((v, c) => v === color[c])) return;
  const visited = new Uint8Array(width * height),
    stack = [y * width + x];
  while (stack.length) {
    const cell = stack.pop()!;
    if (visited[cell]) continue;
    visited[cell] = 1;
    const i = cell * 4;
    if (!target.every((v, c) => v === data[i + c])) continue;
    data.set(color, i);
    const cx = cell % width,
      cy = Math.floor(cell / width);
    if (cx > 0) stack.push(cell - 1);
    if (cx < width - 1) stack.push(cell + 1);
    if (cy > 0) stack.push(cell - width);
    if (cy < height - 1) stack.push(cell + width);
  }
}
export function playbackOrder(tag: AnimationTag | undefined, count: number) {
  const from = tag?.from ?? 0,
    to = tag?.to ?? count - 1;
  const order = Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
  if (tag?.direction === 'reverse') return order.reverse();
  if (tag?.direction === 'pingpong' && order.length > 2)
    return [...order, ...order.slice(1, -1).reverse()];
  return order;
}
export function frameAtTime(doc: SpriteDocument, order: number[], timeMs: number) {
  const duration = order.reduce((sum, i) => sum + doc.frames[i].duration, 0);
  let local = ((timeMs % duration) + duration) % duration;
  for (const i of order) {
    if (local < doc.frames[i].duration) return i;
    local -= doc.frames[i].duration;
  }
  return order[order.length - 1] ?? 0;
}
export function moveFrame(doc: SpriteDocument, from: number, to: number): SpriteDocument {
  if (from === to || to < 0 || to >= doc.frames.length) return doc;
  const frames = [...doc.frames],
    [item] = frames.splice(from, 1);
  frames.splice(to, 0, item);
  // Tags refer to timeline slots; reordering changes the content at those slots.
  return { ...doc, frames };
}
export function deleteFrame(doc: SpriteDocument, index: number): SpriteDocument {
  if (doc.frames.length === 1) return doc;
  const frames = doc.frames.filter((_, i) => i !== index);
  const tags = doc.tags.flatMap((tag) => {
    if (tag.from === index && tag.to === index) return [];
    return [
      {
        ...tag,
        from: tag.from > index ? tag.from - 1 : tag.from,
        to: tag.to >= index ? tag.to - 1 : tag.to,
      },
    ];
  });
  return { ...doc, frames, tags };
}
export function resizeCanvas(doc: SpriteDocument, width: number, height: number): SpriteDocument {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 512 ||
    height > 512 ||
    width * height * doc.frames.length > 16_000_000
  )
    throw Error('Canvas must be 1–512 pixels per side and fit the 16 million total pixel limit.');
  const frames = doc.frames.map((frame) => {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < Math.min(height, doc.height); y++)
      pixels.set(
        frame.pixels.subarray(y * doc.width * 4, (y * doc.width + Math.min(width, doc.width)) * 4),
        y * width * 4,
      );
    return { ...frame, pixels };
  });
  const next = {
    ...doc,
    width,
    height,
    frames,
    pivot: { x: Math.min(doc.pivot.x, width), y: Math.min(doc.pivot.y, height) },
  };
  validateDocument(next);
  return next;
}
/** Original six-frame pixel animation for trying the asset workflow. */
export function sampleSprite(): SpriteDocument {
  const doc = createDocument(32, 32, 'slime');
  doc.frames = [];
  for (let f = 0; f < 6; f++) {
    const pixels = new Uint8ClampedArray(32 * 32 * 4),
      bounce = [0, -1, -2, -1, 0, 0][f],
      squash = f === 5;
    const rx = squash ? 11 : 9,
      ry = squash ? 5 : 8,
      cy = squash ? 24 : 21 + bounce;
    const set = (x: number, y: number, c: number[]) => pixels.set([...c, 255], (y * 32 + x) * 4);
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        const d = ((x - 16) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (d <= 1 && y <= 28)
          set(x, y, d > 0.76 ? [38, 75, 60] : y < cy - 2 ? [181, 224, 112] : [112, 171, 86]);
      }
    for (const x of [12, 20]) for (let y = cy - 2; y < cy + 1; y++) set(x, y, [25, 48, 45]);
    set(16, cy + 2, [40, 75, 54]);
    if (!squash) {
      set(11, cy - 5, [224, 246, 168]);
      set(12, cy - 5, [224, 246, 168]);
    }
    doc.frames.push({ id: newId(), pixels, duration: f === 0 ? 180 : 100 });
  }
  doc.tags = [{ name: 'idle', from: 0, to: 5, direction: 'forward' }];
  return doc;
}
