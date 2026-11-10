export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
export const MAX_EXPORT_BYTES = 64 * 1024 * 1024;

export function assertParams(
  value: unknown,
  allowed: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Parameters must be an object.');
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw Error(`Unknown parameter: ${key}.`);
}
export function integer(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw Error(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}
export function numberInRange(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw Error(`${label} must be from ${min} to ${max}.`);
  return value;
}
export function textValue(value: unknown, label: string, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw Error(`${label} must contain 1–${max} characters.`);
  return value;
}
export function base64ToBytes(value: unknown, maxBytes = MAX_IMPORT_BYTES) {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(maxBytes / 3) * 4 ||
    !value.length ||
    value.length % 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw Error(`Provide valid base64 data up to ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
  const binary = atob(value);
  if (binary.length > maxBytes) throw Error('Import exceeds the automation size limit.');
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
export function bytesToBase64(bytes: Uint8Array) {
  if (bytes.length > MAX_EXPORT_BYTES)
    throw Error('This export exceeds the 64 MB automation limit. Export it in the app instead.');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
