import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { desktop } from '../platform';
import { pngBytes, scaleCanvas } from '../media';
import { throwIfCancelled, type Progress } from '../export';
import { frameCanvas, safeName } from './io';
import { validateDocument, type SpriteDocument } from './model';

export interface SpriteVideoOptions {
  doc: SpriteDocument;
  order?: number[];
  format: 'mov' | 'webm';
  ffmpeg: string;
  signal: AbortSignal;
  progress: (progress: Progress) => void;
  scale?: number;
}

/** Build the exact sequence sent to the encoder; preview FPS must not retime edited frames. */
export function spriteVideoPlan(
  doc: SpriteDocument,
  order = doc.frames.map((_, index) => index),
  scale = 1,
) {
  validateDocument(doc);
  if (![1, 2, 4, 8].includes(scale))
    throw Error('Choose a video export scale of 1×, 2×, 4× or 8×.');
  if (
    !order.length ||
    order.length > 1800 ||
    order.some((index) => !Number.isInteger(index) || index < 0 || index >= doc.frames.length)
  )
    throw Error('Choose a valid animation range with up to 1,800 frames.');
  const frameDurationsMs = order.map((index) => {
    const duration = doc.frames[index].duration;
    if (!Number.isInteger(duration))
      throw Error(`Frame ${index + 1} needs a whole-millisecond duration for video export.`);
    return duration;
  });
  return {
    order: [...order],
    frameDurationsMs,
    scale,
    width: doc.width * scale,
    height: doc.height * scale,
    duration: frameDurationsMs.reduce((total, duration) => total + duration, 0),
  };
}

/** Encode edited RGBA frames, preserving selected order and each frame's actual duration. */
export async function exportSpriteVideo({
  doc,
  order,
  format,
  ffmpeg,
  signal,
  progress,
  scale = 1,
}: SpriteVideoOptions) {
  if (!desktop) throw Error('MOV and WebM export are available in the desktop app.');
  const plan = spriteVideoPlan(doc, order, scale);
  if (!['mov', 'webm'].includes(format)) throw Error('Choose MOV or WebM export.');
  if (!ffmpeg.trim())
    throw Error('Set the FFmpeg executable path in App settings before exporting video.');
  throwIfCancelled(signal);
  let capabilities: { frameDurationsMs?: boolean; formats?: string[] };
  try {
    capabilities = await invoke('video_export_capabilities');
  } catch {
    throw Error(
      'This running desktop build does not support timed frame exports. Open the latest build to export MOV or WebM.',
    );
  }
  if (!capabilities.frameDurationsMs || !capabilities.formats?.includes(format))
    throw Error(
      'This desktop build does not support the requested video export with frame timing.',
    );
  throwIfCancelled(signal);
  progress({ fraction: 0, label: 'Choose where to save the video…' });
  const output = await save({
    defaultPath: `${safeName(doc.name)}.${format}`,
    filters: [
      {
        name: format === 'mov' ? 'MOV · ProRes 4444 with alpha' : 'WebM · VP9 with alpha',
        extensions: [format],
      },
    ],
  });
  if (!output) return false;
  throwIfCancelled(signal);
  let session: string | undefined;
  try {
    session = await invoke<string>('begin_encode', {
      output,
      format,
      ffmpeg,
      // Required by the legacy command. The native timed path uses frameDurationsMs instead.
      fps: 12,
      frameDurationsMs: plan.frameDurationsMs,
    });
    for (let index = 0; index < plan.order.length; index++) {
      throwIfCancelled(signal);
      const frame = doc.frames[plan.order[index]];
      const original = frameCanvas(frame.pixels, doc.width, doc.height);
      const png = await pngBytes(scale === 1 ? original : scaleCanvas(original, scale));
      throwIfCancelled(signal);
      await invoke('write_encode_frame', { id: session, index, png: Array.from(png) });
      progress({
        fraction: (index + 1) / plan.order.length,
        label: `Preparing video frame ${index + 1} of ${plan.order.length}…`,
      });
    }
    throwIfCancelled(signal);
    progress({
      fraction: 1,
      label: `Encoding ${format === 'mov' ? 'MOV' : 'WebM'}… This final step cannot be cancelled.`,
      encoding: true,
    });
    await invoke('finish_encode', { id: session });
    session = undefined;
    return true;
  } finally {
    if (session) await invoke('abort_encode', { id: session }).catch(() => {});
  }
}
