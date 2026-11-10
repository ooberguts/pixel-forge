import { expect, it } from 'vitest';
import { defaults } from './engine';
import { validateSettings, validateTrim } from './converterSettings';
it('validates automation/preset settings atomically and keeps unspecified settings', () => {
  expect(
    validateSettings({ width: 64, alpha: 'key' }, { ...defaults, palette: 'earth' }),
  ).toMatchObject({ width: 64, alpha: 'key', palette: 'earth' });
  for (const value of [
    { width: 7 },
    { width: 12.5 },
    { colors: 300 },
    { brightness: NaN },
    { keyColor: 'green' },
    { keyColor: ['#ff00ff'] },
    { toString: 'invalid' },
    { unexpected: true },
    { palette: 'unknown' },
  ])
    expect(() => validateSettings(value)).toThrow();
  expect(defaults.width).toBe(128);
});
it('rejects invalid trim ranges instead of moving the playhead to an invalid time', () => {
  expect(validateTrim({ start: 0.25, end: 0.75 }, 1)).toEqual({ start: 0.25, end: 0.75 });
  for (const value of [
    { start: -1, end: 1 },
    { start: 1, end: 1 },
    { start: 0, end: 2 },
    { start: 0, end: NaN },
  ])
    expect(() => validateTrim(value, 1)).toThrow();
  expect(() => validateTrim({ start: 0, end: 1 }, 0)).toThrow('video');
});
