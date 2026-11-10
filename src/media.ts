import { defaults, prepare, processPixels, type RGB, type Settings } from './engine';
import { frameTransform, type Stabilization } from './stabilization';
import { decodeGif } from './sprites/gif';
import type { SpriteDocument } from './sprites/model';

export interface Media {
  name: string;
  kind: 'image' | 'video';
  source: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;
  width: number;
  height: number;
  duration: number;
  url?: string;
  reference?: HTMLCanvasElement;
  animation?: SpriteDocument;
}
export function disposeMedia(media: Media) {
  if (media.source instanceof HTMLVideoElement) {
    media.source.pause();
    media.source.removeAttribute('src');
    media.source.load();
  }
  if (media.url) URL.revokeObjectURL(media.url);
}
export async function loadMedia(file: File, maxPixels = 80_000_000): Promise<Media> {
  if (file.type === 'image/gif' || /\.gif$/i.test(file.name))
    return mediaFromAnimation(
      decodeGif(new Uint8Array(await file.arrayBuffer()), file.name),
      file.name,
    );
  const url = URL.createObjectURL(file);
  const video = file.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|ogv|mkv)$/i.test(file.name);
  try {
    if (video) {
      const source = document.createElement('video');
      source.muted = true;
      source.playsInline = true;
      source.preload = 'auto';
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Video took too long to open. Try MP4 or WebM.')),
          20000,
        );
        source.onloadeddata = () => {
          clearTimeout(timer);
          resolve();
        };
        source.onerror = () => {
          clearTimeout(timer);
          reject(
            new Error(
              'This video codec is not supported by this preview. Try H.264 MP4 or VP9 WebM. ProRes input needs the planned native decoder.',
            ),
          );
        };
        source.src = url;
      });
      if (!Number.isFinite(source.duration) || source.duration <= 0)
        throw new Error('The video needs a finite duration. Live streams are not supported yet.');
      if (source.videoWidth * source.videoHeight > maxPixels) {
        source.pause();
        source.removeAttribute('src');
        source.load();
        throw new Error(`Use source frames smaller than ${maxPixels / 1_000_000} megapixels.`);
      }
      const reference = document.createElement('canvas');
      reference.width = source.videoWidth;
      reference.height = source.videoHeight;
      reference.getContext('2d')!.drawImage(source, 0, 0);
      return {
        name: file.name,
        kind: 'video',
        source,
        width: source.videoWidth,
        height: source.videoHeight,
        duration: source.duration,
        url,
        reference,
      };
    }
    const source = new Image();
    source.src = url;
    await source.decode();
    if (source.width * source.height > maxPixels)
      throw new Error(`Please use an image smaller than ${maxPixels / 1_000_000} megapixels.`);
    return {
      name: file.name,
      kind: 'image',
      source,
      width: source.naturalWidth,
      height: source.naturalHeight,
      duration: 0,
      url,
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
/** Editable frames are a first-class animation source, retaining RGBA and millisecond timing. */
export function mediaFromAnimation(animation: SpriteDocument, name = animation.name): Media {
  const source = document.createElement('canvas');
  source.width = animation.width;
  source.height = animation.height;
  const media: Media = {
    name,
    kind: 'video',
    source,
    width: animation.width,
    height: animation.height,
    duration: animation.frames.reduce((total, frame) => total + frame.duration, 0) / 1000,
    animation,
  };
  drawAnimationFrame(media, 0);
  const reference = document.createElement('canvas');
  reference.width = source.width;
  reference.height = source.height;
  reference.getContext('2d')!.drawImage(source, 0, 0);
  media.reference = reference;
  return media;
}
export function drawAnimationFrame(media: Media, time: number) {
  if (!media.animation) return;
  let remaining = Math.max(0, time * 1000);
  let frame = media.animation.frames[media.animation.frames.length - 1];
  for (const candidate of media.animation.frames) {
    frame = candidate;
    if (remaining < candidate.duration - 0.00001) break;
    remaining -= candidate.duration;
  }
  (media.source as HTMLCanvasElement)
    .getContext('2d')!
    .putImageData(
      new ImageData(new Uint8ClampedArray(frame.pixels), media.width, media.height),
      0,
      0,
    );
}
export async function seekMedia(media: Media, time: number) {
  if (media.animation) drawAnimationFrame(media, time);
  else if (media.source instanceof HTMLVideoElement) await seekVideo(media.source, time);
}
export async function seekVideo(video: HTMLVideoElement, time: number) {
  if (Math.abs(video.currentTime - time) < 0.0001 && video.readyState >= 2) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', fail);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error('Could not decode this video frame.'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out seeking a video frame.'));
    }, 15000);
    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('error', fail, { once: true });
    video.currentTime = time;
  });
}
export function renderMedia(
  media: Media,
  settings: Settings,
  lockedPalette?: RGB[],
  stabilization?: Stabilization,
  time = 0,
  pixelSnap = false,
) {
  if (media.animation) drawAnimationFrame(media, time);
  const canvas = document.createElement('canvas');
  canvas.width = settings.width;
  canvas.height = Math.max(1, Math.round((settings.width * media.height) / media.width));
  if (canvas.height > 4096)
    throw new Error('This aspect ratio is too tall. Reduce the pixel width.');
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  const t = stabilization ? frameTransform(stabilization, time) : { x: 0, y: 0, scale: 1 };
  let source = media.source;
  let outputSettings = settings;
  if (media.animation && settings.alpha === 'key') {
    const original = (media.source as HTMLCanvasElement)
      .getContext('2d')!
      .getImageData(0, 0, media.width, media.height);
    const keyed = document.createElement('canvas');
    keyed.width = media.width;
    keyed.height = media.height;
    keyed.getContext('2d')!.putImageData(
      new ImageData(
        new Uint8ClampedArray(
          prepare(original.data, {
            ...defaults,
            alpha: 'key',
            keyColor: settings.keyColor,
            keyTolerance: settings.keyTolerance,
            keySoftness: settings.keySoftness,
          }),
        ),
        media.width,
        media.height,
      ),
      0,
      0,
    );
    source = keyed;
    outputSettings = { ...settings, alpha: 'preserve' };
  }
  context.drawImage(
    source,
    pixelSnap ? Math.round(t.x * canvas.width) : t.x * canvas.width,
    pixelSnap ? Math.round(t.y * canvas.height) : t.y * canvas.height,
    canvas.width * t.scale,
    canvas.height * t.scale,
  );
  const raw = context.getImageData(0, 0, canvas.width, canvas.height);
  const result = processPixels(raw.data, canvas.width, outputSettings, lockedPalette);
  context.putImageData(
    new ImageData(new Uint8ClampedArray(result.data), canvas.width, canvas.height),
    0,
    0,
  );
  return { canvas, palette: result.palette };
}
export function scaleCanvas(source: HTMLCanvasElement, scale: number, grid = false) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width * scale;
  canvas.height = source.height * scale;
  if (canvas.width * canvas.height > 32_000_000)
    throw new Error('Export exceeds 32 megapixels. Choose a smaller export scale.');
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (grid && scale >= 4) {
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= canvas.width; x += scale) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, canvas.height);
    }
    for (let y = 0; y <= canvas.height; y += scale) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(canvas.width, y + 0.5);
    }
    ctx.stroke();
  }
  return canvas;
}
export const pngBytes = async (canvas: HTMLCanvasElement): Promise<Uint8Array> => {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed.'))),
      'image/png',
    ),
  );
  return new Uint8Array(await blob.arrayBuffer());
};

/** Original procedural sample, painted locally. No external assets or requests. */
export function demoMedia(): Media {
  const canvas = document.createElement('canvas');
  canvas.width = 1000;
  canvas.height = 750;
  const c = canvas.getContext('2d')!;
  const sky = c.createLinearGradient(0, 0, 0, 490);
  sky.addColorStop(0, '#748e99');
  sky.addColorStop(0.55, '#c5c3a5');
  sky.addColorStop(1, '#ecd7ad');
  c.fillStyle = sky;
  c.fillRect(0, 0, 1000, 750);
  c.fillStyle = '#f5e4b6';
  c.beginPath();
  c.arc(677, 204, 56, 0, Math.PI * 2);
  c.fill();
  const shape = (points: number[][], color: string) => {
    c.fillStyle = color;
    c.beginPath();
    points.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.closePath();
    c.fill();
  };
  shape(
    [
      [0, 365],
      [75, 289],
      [140, 318],
      [276, 128],
      [348, 240],
      [415, 189],
      [532, 323],
      [621, 259],
      [706, 317],
      [824, 175],
      [940, 298],
      [1000, 251],
      [1000, 610],
      [0, 610],
    ],
    '#7d9190',
  );
  shape(
    [
      [140, 318],
      [276, 128],
      [348, 240],
      [318, 220],
      [297, 225],
      [270, 183],
      [239, 242],
      [211, 247],
    ],
    '#dedbc4',
  );
  shape(
    [
      [706, 317],
      [824, 175],
      [940, 298],
      [879, 268],
      [854, 266],
      [824, 214],
      [807, 241],
      [781, 244],
    ],
    '#d0d3bf',
  );
  shape(
    [
      [0, 420],
      [134, 349],
      [223, 389],
      [349, 320],
      [439, 406],
      [565, 361],
      [680, 402],
      [773, 327],
      [887, 365],
      [1000, 311],
      [1000, 610],
      [0, 610],
    ],
    '#607c72',
  );
  const lake = c.createLinearGradient(0, 430, 0, 750);
  lake.addColorStop(0, '#a4b5a1');
  lake.addColorStop(0.6, '#627f7b');
  lake.addColorStop(1, '#3c5c5d');
  c.fillStyle = lake;
  c.fillRect(0, 451, 1000, 299);
  shape(
    [
      [0, 435],
      [167, 421],
      [311, 445],
      [442, 447],
      [564, 456],
      [385, 469],
      [180, 469],
      [0, 501],
    ],
    '#3c6256',
  );
  shape(
    [
      [1000, 405],
      [874, 424],
      [787, 443],
      [631, 460],
      [725, 471],
      [882, 463],
      [1000, 487],
    ],
    '#344f4c',
  );
  c.fillStyle = '#d5c8a0';
  for (let i = 0; i < 35; i++) {
    const y = 480 + i * 7;
    const w = 20 + i * 3;
    c.globalAlpha = 0.25;
    c.fillRect(677 - w / 2 + Math.sin(i * 6) * 30, y, w, 2);
  }
  c.globalAlpha = 1;
  function tree(x: number, y: number, h: number, color: string) {
    c.fillStyle = color;
    c.fillRect(x - h * 0.025, y - h * 0.9, h * 0.05, h * 0.97);
    for (let j = 0; j < 4; j++) {
      const top = y - h + j * h * 0.17;
      shape(
        [
          [x, top],
          [x - h * (0.13 + j * 0.026), top + h * 0.38],
          [x + h * (0.13 + j * 0.026), top + h * 0.38],
        ],
        color,
      );
    }
  }
  for (let i = 0; i < 37; i++) {
    const x = i * 29;
    const edge = x < 430 ? 458 - x * 0.027 : 462;
    tree(x, edge, 30 + (Math.sin(i * 13) + 1) * 29, '#365b51');
  }
  shape(
    [
      [0, 615],
      [110, 626],
      [206, 671],
      [294, 685],
      [383, 750],
      [0, 750],
    ],
    '#293f3b',
  );
  shape(
    [
      [1000, 562],
      [922, 600],
      [865, 646],
      [831, 750],
      [1000, 750],
    ],
    '#253c37',
  );
  for (let i = 0; i < 10; i++)
    tree(35 + i * 24, 687 + i * 4, 160 + (Math.sin(i * 7) + 1) * 72, '#233b35');
  tree(944, 695, 324, '#213932');
  tree(1000, 680, 250, '#29473b');
  tree(830, 748, 155, '#29453c');
  shape(
    [
      [490, 612],
      [562, 612],
      [549, 622],
      [502, 622],
    ],
    '#3b3836',
  );
  c.fillStyle = '#d2ad79';
  c.fillRect(526, 595, 4, 16);
  c.fillStyle = '#473c34';
  c.fillRect(526, 590, 4, 9);
  c.strokeStyle = '#b2b995';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(528, 605);
  c.lineTo(550, 621);
  c.stroke();
  for (let i = 0; i < 28; i++) {
    c.fillStyle = i % 3 ? '#8a9d79' : '#c1bc89';
    c.fillRect((i * 71) % 260, 710 + ((i * 13) % 40), 3, 6);
  }
  return {
    name: 'Alpine lake · sample',
    kind: 'image',
    source: canvas,
    width: 1000,
    height: 750,
    duration: 0,
  };
}
