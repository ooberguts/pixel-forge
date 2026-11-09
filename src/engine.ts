export type RGB = [number, number, number];
export type PaletteId = 'original' | 'adaptive' | 'pico8' | 'earth' | 'gameboy' | 'mono' | 'custom';
export interface Settings {
  width: number;
  palette: PaletteId;
  colors: number;
  customPalette: string;
  dither: 'none' | 'bayer' | 'floyd';
  ditherStrength: number;
  brightness: number;
  contrast: number;
  saturation: number;
  alpha: 'preserve' | 'threshold' | 'key' | 'opaque';
  alphaThreshold: number;
  keyColor: string;
  keyTolerance: number;
  keySoftness: number;
}
export const defaults: Settings = {
  width: 128,
  palette: 'pico8',
  colors: 16,
  customPalette: '#172038 #394a68 #647c8c #a0b5aa #e6e8cf',
  dither: 'bayer',
  ditherStrength: 10,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  alpha: 'preserve',
  alphaThreshold: 128,
  keyColor: '#00ff00',
  keyTolerance: 70,
  keySoftness: 20,
};
export const PALETTES: Record<string, { name: string; colors: string[] }> = {
  pico8: {
    name: 'PICO-8',
    colors: [
      '#000000',
      '#1d2b53',
      '#7e2553',
      '#008751',
      '#ab5236',
      '#5f574f',
      '#c2c3c7',
      '#fff1e8',
      '#ff004d',
      '#ffa300',
      '#ffec27',
      '#00e436',
      '#29adff',
      '#83769c',
      '#ff77a8',
      '#ffccaa',
    ],
  },
  earth: {
    name: 'Field notes',
    colors: [
      '#202d35',
      '#394b50',
      '#53685c',
      '#7b8b63',
      '#aeb87b',
      '#d8d3a2',
      '#f0e5c9',
      '#bbab86',
      '#9d7960',
      '#85524a',
      '#593e42',
      '#382f3d',
    ],
  },
  gameboy: { name: 'Pocket green', colors: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'] },
  mono: { name: 'Ink & paper', colors: ['#20262c', '#59636b', '#a4ada9', '#eee9d8'] },
};
export const hexRGB = (hex: string): RGB => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
export const rgbHex = (rgb: RGB) =>
  '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
export function parsePalette(input: string): RGB[] {
  const hexes = input.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
  return [...new Set(hexes.map((v) => v.toLowerCase()))].slice(0, 256).map(hexRGB);
}
const clamp = (v: number) => Math.max(0, Math.min(255, v));

/** Adjust straight RGBA. Keying happens before grading; hidden RGB never enters a palette. */
export function prepare(data: Uint8ClampedArray, settings: Settings): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  const key = hexRGB(settings.keyColor);
  const contrast = Math.pow((100 + settings.contrast) / 100, 2);
  for (let i = 0; i < data.length; i += 4) {
    let alpha = data[i + 3];
    if (settings.alpha === 'opaque') alpha = 255;
    if (settings.alpha === 'threshold') alpha = alpha >= settings.alphaThreshold ? 255 : 0;
    if (settings.alpha === 'key') {
      const distance = Math.hypot(data[i] - key[0], data[i + 1] - key[1], data[i + 2] - key[2]);
      const coverage =
        settings.keySoftness > 0
          ? Math.max(0, Math.min(1, (distance - settings.keyTolerance) / settings.keySoftness))
          : Number(distance > settings.keyTolerance);
      alpha = Math.round(alpha * coverage);
    }
    out[i + 3] = alpha;
    if (!alpha) continue;
    const luma = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
    for (let c = 0; c < 3; c++) {
      const saturated = luma + (data[i + c] - luma) * (1 + settings.saturation / 100);
      out[i + c] = clamp((saturated - 128) * contrast + 128 + settings.brightness * 2.55);
    }
  }
  return out;
}

/** Weighted median cut. Deterministic, excludes invisible colors, bounded histogram. */
export function adaptivePalette(data: Uint8ClampedArray, count: number): RGB[] {
  const histogram = new Map<number, { rgb: RGB; weight: number }>();
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    const existing = histogram.get(k);
    if (existing) existing.weight += data[i + 3] / 255;
    else histogram.set(k, { rgb: [data[i], data[i + 1], data[i + 2]], weight: data[i + 3] / 255 });
  }
  type Entry = { rgb: RGB; weight: number };
  const boxes: Entry[][] = [[...histogram.values()]];
  if (!boxes[0].length) return [[0, 0, 0]];
  const range = (box: Entry[]) =>
    [0, 1, 2].map((c) => {
      let min = 255,
        max = 0;
      for (const e of box) {
        min = Math.min(min, e.rgb[c]);
        max = Math.max(max, e.rgb[c]);
      }
      return max - min;
    });
  while (boxes.length < count) {
    let best = -1,
      score = -1,
      channel = 0;
    boxes.forEach((box, index) => {
      if (box.length < 2) return;
      const ranges = range(box),
        widest = Math.max(...ranges);
      const value = widest * Math.sqrt(box.reduce((s, e) => s + e.weight, 0));
      if (value > score) {
        score = value;
        best = index;
        channel = ranges.indexOf(widest);
      }
    });
    if (best < 0) break;
    const box = boxes[best].sort((a, b) => a.rgb[channel] - b.rgb[channel]);
    const half = box.reduce((s, e) => s + e.weight, 0) / 2;
    let weight = 0,
      split = 1;
    for (let i = 0; i < box.length - 1; i++) {
      weight += box[i].weight;
      split = i + 1;
      if (weight >= half) break;
    }
    boxes.splice(best, 1, box.slice(0, split), box.slice(split));
  }
  return boxes.map((box) => {
    const total = box.reduce((s, e) => s + e.weight, 0);
    return [0, 1, 2].map((c) =>
      Math.round(box.reduce((s, e) => s + e.rgb[c] * e.weight, 0) / total),
    ) as RGB;
  });
}
export function getPalette(data: Uint8ClampedArray, settings: Settings): RGB[] {
  if (settings.palette === 'original') return [];
  if (settings.palette === 'adaptive') return adaptivePalette(data, settings.colors);
  if (settings.palette === 'custom') return parsePalette(settings.customPalette);
  return PALETTES[settings.palette].colors.map(hexRGB);
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export function quantize(
  data: Uint8ClampedArray,
  width: number,
  palette: RGB[],
  settings: Settings,
): Uint8ClampedArray {
  if (!palette.length) return data.slice();
  const out = data.slice(),
    work = Float32Array.from(data),
    height = data.length / 4 / width;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (!data[i + 3]) continue;
      const offset =
        settings.dither === 'bayer'
          ? (BAYER[(y % 4) * 4 + (x % 4)] / 16 - 0.46875) * settings.ditherStrength * 2
          : 0;
      const rgb = [0, 1, 2].map((c) => clamp(work[i + c] + offset));
      let best = palette[0],
        distance = Infinity;
      for (const p of palette) {
        const d =
          (rgb[0] - p[0]) ** 2 * 0.2126 +
          (rgb[1] - p[1]) ** 2 * 0.7152 +
          (rgb[2] - p[2]) ** 2 * 0.0722;
        if (d < distance) {
          best = p;
          distance = d;
        }
      }
      for (let c = 0; c < 3; c++) out[i + c] = best[c];
      if (settings.dither === 'floyd') {
        for (const [dx, dy, w] of [
          [1, 0, 7 / 16],
          [-1, 1, 3 / 16],
          [0, 1, 5 / 16],
          [1, 1, 1 / 16],
        ]) {
          const nx = x + dx,
            ny = y + dy,
            j = (ny * width + nx) * 4;
          if (nx < 0 || nx >= width || ny >= height || !data[j + 3]) continue;
          for (let c = 0; c < 3; c++)
            work[j + c] += (rgb[c] - best[c]) * w * (settings.ditherStrength / 50);
        }
      }
    }
  return out;
}
export function processPixels(
  data: Uint8ClampedArray,
  width: number,
  settings: Settings,
  lockedPalette?: RGB[],
) {
  const prepared = prepare(data, settings);
  const palette = lockedPalette ?? getPalette(prepared, settings);
  return { data: quantize(prepared, width, palette, settings), palette };
}
