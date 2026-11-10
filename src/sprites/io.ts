import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { saveBytes } from '../platform';
import { pngBytes } from '../media';
import { buildAtlasPixels, atlasMetadata } from './atlas';
import { newId, validateDocument, type SpriteDocument, type SheetOptions } from './model';

export function frameCanvas(pixels: Uint8ClampedArray, width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas
    .getContext('2d')!
    .putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  return canvas;
}
export const safeName = (name: string) =>
  name
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80) || 'sprite';
export async function buildAssetPack(doc: SpriteDocument, options: SheetOptions) {
  const base = safeName(doc.name),
    atlas = buildAtlasPixels(doc, options);
  const files: Record<string, Uint8Array> = {};
  files[`${base}.png`] = await pngBytes(frameCanvas(atlas.pixels, atlas.width, atlas.height));
  files[`${base}.json`] = strToU8(
    JSON.stringify(atlasMetadata({ ...doc, name: base }, options, `${base}.png`), null, 2),
  );
  for (let i = 0; i < doc.frames.length; i++)
    files[`frames/${base}-${String(i).padStart(4, '0')}.png`] = await pngBytes(
      frameCanvas(doc.frames[i].pixels, doc.width, doc.height),
    );
  files['IMPORT.txt'] = strToU8(
    `Pixel Forge game asset pack\n\n${base}.png + ${base}.json: lossless RGBA atlas and Aseprite-style JSON array metadata.\nframes/: untrimmed, logical-resolution PNG sequence.\n\nAll frame coordinates are top-left pixels. Frame duration is milliseconds. Tag from/to indices are zero-based and inclusive. Pivot is relative to the untrimmed source canvas, not a trimmed atlas rectangle. The custom meta.pixelForge section documents layout and pixel-space pivot. No atlas frame is rotated. Reconstruct trimmed frames using spriteSourceSize and sourceSize. Empty frames retain their timing as transparent 1x1 atlas regions.\n\nUse nearest/point filtering, disable mipmaps and lossy/VRAM texture compression for crisp 2D pixel art. Keep one pixels-per-unit convention across your project and use an integer-scaled camera/viewport. Correct rendering still depends on your engine and camera. Power-of-two textures are optional, not a universal requirement.\n\nGodot: import PNG losslessly, select Nearest texture filtering on CanvasItem/project, and build SpriteFrames using the exported rectangles and durations.\nUnity: Sprite (2D and UI), Multiple, Point filtering, no mipmaps, uncompressed. Slice using JSON or use the untrimmed PNG sequence. Set Pixels Per Unit and consistent pivots.\nPhaser: load PNG+JSON as an atlas; Aseprite-style frameTags and durations are supplied for animation construction.\n\nThis is interoperable sprite-sheet JSON, not an .aseprite source document. Importer support varies; engine-specific scripts are not included.\n`,
  );
  return zipSync(files, { level: 0 });
}
export async function exportAssetPack(doc: SpriteDocument, options: SheetOptions) {
  return saveBytes(
    await buildAssetPack(doc, options),
    `${safeName(doc.name)}-game-assets.zip`,
    'zip',
  );
}
export function encodeProject(doc: SpriteDocument) {
  validateDocument(doc);
  const files: Record<string, Uint8Array> = {};
  const frames = doc.frames.map((frame, index) => {
    const file = `frames/${String(index).padStart(4, '0')}.rgba`;
    files[file] = new Uint8Array(frame.pixels);
    return { file, id: frame.id, duration: frame.duration };
  });
  files['project.json'] = strToU8(
    JSON.stringify({ schema: 'pixel-forge-sprite', version: 1, ...doc, frames }),
  );
  return zipSync(files, { level: 1 });
}
export function decodeProject(bytes: Uint8Array): SpriteDocument {
  if (bytes.byteLength > 100 * 1024 * 1024) throw Error('Project exceeds the 100 MB input limit.');
  let total = 0,
    count = 0;
  const files = unzipSync(bytes, {
    filter: (file) => {
      if (
        ++count > 258 ||
        file.originalSize > 64 * 1024 * 1024 ||
        (total += file.originalSize) > 70 * 1024 * 1024
      )
        throw Error('Project archive exceeds the decompressed size limit.');
      return file.name === 'project.json' || /^frames\/\d{4}\.rgba$/.test(file.name);
    },
  });
  if (!files['project.json'] || files['project.json'].length > 200000)
    throw Error('Invalid Pixel Forge project.');
  const data = JSON.parse(strFromU8(files['project.json']));
  if (
    data.schema !== 'pixel-forge-sprite' ||
    data.version !== 1 ||
    !Array.isArray(data.frames) ||
    !Array.isArray(data.tags) ||
    !data.pivot
  )
    throw Error('Unsupported sprite project.');
  const doc: SpriteDocument = {
    name: data.name,
    gifRepeat: data.gifRepeat,
    width: data.width,
    height: data.height,
    tags: data.tags,
    pivot: data.pivot,
    frames: data.frames.map((f: { file: string; duration: number }) => {
      if (!/^frames\/\d{4}\.rgba$/.test(f.file) || !files[f.file])
        throw Error('Missing sprite frame.');
      return { id: newId(), duration: f.duration, pixels: new Uint8ClampedArray(files[f.file]) };
    }),
  };
  validateDocument(doc);
  return doc;
}
async function readImage(file: File) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (image.width * image.height > 32_000_000) throw Error('Image exceeds 32 megapixels.');
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d')!.drawImage(image, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function importPngFrames(files: File[], duration: number): Promise<SpriteDocument> {
  if (files.length < 1 || files.length > 256) throw Error('Select 1–256 image frames.');
  const sorted = [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  const canvases: HTMLCanvasElement[] = [];
  for (const file of sorted) {
    const canvas = await readImage(file);
    if (canvas.width > 512 || canvas.height > 512)
      throw Error(
        'Frames must be at most 512 × 512. Use the image converter to reduce larger images.',
      );
    canvases.push(canvas);
    const w = Math.max(...canvases.map((c) => c.width)),
      h = Math.max(...canvases.map((c) => c.height));
    if (w * h * files.length > 16_000_000) throw Error('Frame sequence exceeds 16 million pixels.');
  }
  const width = Math.max(...canvases.map((c) => c.width)),
    height = Math.max(...canvases.map((c) => c.height));
  const doc: SpriteDocument = {
    name: sorted[0].name.replace(/\.[^.]+$/, ''),
    width,
    height,
    pivot: { x: Math.floor(width / 2), y: height },
    tags: [],
    frames: canvases.map((canvas) => {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      c.getContext('2d')!.drawImage(canvas, 0, 0);
      return {
        id: newId(),
        duration,
        pixels: c.getContext('2d')!.getImageData(0, 0, width, height).data,
      };
    }),
  };
  validateDocument(doc);
  return doc;
}
export async function importSheet(
  file: File,
  width: number,
  height: number,
  padding: number,
  margin: number,
  count: number,
  duration: number,
): Promise<SpriteDocument> {
  if (
    ![width, height, padding, margin, count].every(Number.isInteger) ||
    width < 1 ||
    height < 1 ||
    width > 512 ||
    height > 512 ||
    width * height * count > 16_000_000 ||
    padding < 0 ||
    margin < 0 ||
    count < 1 ||
    count > 256
  )
    throw Error('Enter valid sprite-sheet dimensions and frame count within the editor limits.');
  const canvas = await readImage(file),
    columns = Math.floor((canvas.width - 2 * margin + padding) / (width + padding)),
    rows = Math.floor((canvas.height - 2 * margin + padding) / (height + padding));
  if (columns < 1 || rows < 1 || count > columns * rows)
    throw Error('The requested cells do not fit in this image.');
  const doc: SpriteDocument = {
    name: file.name.replace(/\.[^.]+$/, ''),
    width,
    height,
    pivot: { x: Math.floor(width / 2), y: height },
    tags: [],
    frames: Array.from({ length: count }, (_, i) => ({
      id: newId(),
      duration,
      pixels: canvas
        .getContext('2d')!
        .getImageData(
          margin + (i % columns) * (width + padding),
          margin + Math.floor(i / columns) * (height + padding),
          width,
          height,
        ).data,
    })),
  };
  validateDocument(doc);
  return doc;
}
