import { defaults, type Settings } from './engine';

export function validateSettings(value: unknown, base: Settings = defaults): Settings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Settings must be an object.');
  for (const key of Object.keys(value))
    if (!Object.hasOwn(defaults, key)) throw Error(`Unknown conversion setting: ${key}.`);
  const next = { ...base, ...value };
  const ranges: Partial<Record<keyof Settings, [number, number]>> = {
    width: [8, 512],
    colors: [2, 64],
    ditherStrength: [0, 100],
    brightness: [-100, 100],
    contrast: [-100, 100],
    saturation: [-100, 100],
    alphaThreshold: [0, 255],
    keyTolerance: [0, 442],
    keySoftness: [0, 200],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const current = next[key as keyof Settings];
    if (typeof current !== 'number' || !Number.isFinite(current) || current < min || current > max)
      throw Error(`Invalid conversion setting: ${key}.`);
  }
  if (!Number.isInteger(next.width) || !Number.isInteger(next.colors))
    throw Error('Pixel width and color count must be whole numbers.');
  if (
    !['original', 'adaptive', 'pico8', 'earth', 'gameboy', 'mono', 'custom'].includes(
      next.palette,
    ) ||
    !['none', 'bayer', 'floyd'].includes(next.dither) ||
    !['preserve', 'threshold', 'key', 'opaque'].includes(next.alpha)
  )
    throw Error('Invalid palette, dithering, or alpha mode.');
  if (
    typeof next.keyColor !== 'string' ||
    !/^#[0-9a-f]{6}$/i.test(next.keyColor) ||
    typeof next.customPalette !== 'string' ||
    next.customPalette.length > 4096
  )
    throw Error('Invalid conversion color.');
  return next;
}

export function validateTrim(value: unknown, duration: number): { start: number; end: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !duration)
    throw Error('Trim requires a video with a finite duration.');
  const trim = value as Record<string, unknown>;
  if (
    Object.keys(trim).some((key) => !['start', 'end'].includes(key)) ||
    typeof trim.start !== 'number' ||
    typeof trim.end !== 'number' ||
    !Number.isFinite(trim.start) ||
    !Number.isFinite(trim.end) ||
    trim.start < 0 ||
    trim.end <= trim.start ||
    trim.end > duration
  )
    throw Error('Trim must stay within the source video, with end after start.');
  return { start: trim.start, end: trim.end };
}
