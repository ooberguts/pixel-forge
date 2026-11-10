import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, X } from 'lucide-react';
import { Dialog } from '../Dialogs';
import { defaults, PALETTES, rgbHex, type Settings } from '../engine';
import { frameCanvas } from './io';
import { convertSpriteFrames, renderSpriteFrame } from './convert';
import type { SpriteDocument } from './model';
import './frame-conversion.css';

export default function FrameConversionDialog({
  doc,
  mode = 'convert',
  onClose,
  onApply,
}: {
  doc: SpriteDocument;
  mode?: 'convert' | 'key';
  onClose: () => void;
  onApply: (next: SpriteDocument) => void;
}) {
  const [settings, setSettings] = useState<Settings>({
    ...defaults,
    width: doc.width,
    palette: 'original',
    dither: 'none',
    alpha: mode === 'key' ? 'key' : 'preserve',
  });
  const [frame, setFrame] = useState(0),
    [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState<number | null>(null),
    [error, setError] = useState('');
  const [widthDraft, setWidthDraft] = useState(String(doc.width));
  const validWidth = Number.isInteger(+widthDraft) && +widthDraft >= 1 && +widthDraft <= 512;
  const sourceRef = useRef<HTMLCanvasElement>(null),
    resultRef = useRef<HTMLCanvasElement>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    if (key === 'width') setWidthDraft(String(value));
    setSettings((s) => ({ ...s, [key]: value }));
  };
  const preview = useMemo(() => {
    try {
      const first = renderSpriteFrame(doc, 0, settings);
      return {
        canvas:
          frame === 0
            ? first.canvas
            : renderSpriteFrame(
                doc,
                frame,
                settings,
                settings.palette === 'adaptive' ? first.palette : undefined,
              ).canvas,
        error: '',
      };
    } catch (e) {
      return { canvas: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [doc, frame, settings]);
  useEffect(() => {
    const original = frameCanvas(doc.frames[frame].pixels, doc.width, doc.height);
    for (const [ref, image] of [
      [sourceRef, original],
      [resultRef, preview.canvas],
    ] as const) {
      if (!ref.current) continue;
      if (!image) {
        ref.current.getContext('2d')!.clearRect(0, 0, ref.current.width, ref.current.height);
        continue;
      }
      ref.current.width = image.width;
      ref.current.height = image.height;
      ref.current.getContext('2d')!.drawImage(image, 0, 0);
    }
  }, [doc, frame, preview]);
  const close = () => {
    controller.current?.abort();
    onClose();
  };
  const sample = (x: number, y: number) => {
    const data = doc.frames[frame].pixels,
      offset = (y * doc.width + x) * 4;
    if (data[offset + 3] === 0) {
      setError('Choose an opaque background pixel.');
      return;
    }
    setSettings((s) => ({
      ...s,
      alpha: 'key',
      keyColor: rgbHex([data[offset], data[offset + 1], data[offset + 2]]),
    }));
    setPlaying(false);
    setError('');
  };
  useEffect(() => {
    if (!playing || progress !== null) return;
    const timer = window.setTimeout(
      () => setFrame((current) => (current + 1) % doc.frames.length),
      doc.frames[frame].duration,
    );
    return () => window.clearTimeout(timer);
  }, [playing, progress, doc, frame]);
  const changed =
    settings.width !== doc.width || settings.palette !== 'original' || settings.alpha === 'key';
  return (
    <Dialog
      title="Pixelate & remove background"
      className="frame-conversion-dialog"
      onClose={close}
    >
      <div className="frame-conversion">
        <div className="modal-heading">
          <div>
            <h2>Pixelate &amp; remove background</h2>
            <p>Use either option or both. Preview here, then apply to your editable frames.</p>
          </div>
          <button className="icon-button" aria-label="Close frame conversion" onClick={close}>
            <X size={18} />
          </button>
        </div>
        <div className="frame-conversion-scroll">
          <fieldset className="frame-conversion-body" disabled={progress !== null}>
            <div className="frame-conversion-preview-panel">
              <div className="frame-conversion-previews">
                <figure>
                  <figcaption>Original</figcaption>
                  <div>
                    <canvas
                      ref={sourceRef}
                      aria-label="Original animation frame"
                      aria-describedby="background-sampling-help"
                      style={{
                        cursor: settings.alpha === 'key' ? 'crosshair' : 'default',
                        width: Math.min(350, (240 * doc.width) / doc.height),
                      }}
                      onClick={(event) => {
                        if (settings.alpha !== 'key' || progress !== null) return;
                        const box = event.currentTarget.getBoundingClientRect();
                        sample(
                          Math.max(
                            0,
                            Math.min(
                              doc.width - 1,
                              Math.floor(((event.clientX - box.left) / box.width) * doc.width),
                            ),
                          ),
                          Math.max(
                            0,
                            Math.min(
                              doc.height - 1,
                              Math.floor(((event.clientY - box.top) / box.height) * doc.height),
                            ),
                          ),
                        );
                      }}
                    />
                  </div>
                </figure>
                <figure>
                  <figcaption>
                    Result · {preview.canvas?.width ?? '—'} × {preview.canvas?.height ?? '—'} px
                  </figcaption>
                  <div>
                    <canvas
                      ref={resultRef}
                      aria-label="Converted animation frame"
                      style={{
                        width: preview.canvas
                          ? Math.min(350, (240 * preview.canvas.width) / preview.canvas.height)
                          : undefined,
                      }}
                    />
                  </div>
                </figure>
              </div>
              <p id="background-sampling-help" className="frame-sampling-help">
                {settings.alpha === 'key'
                  ? 'Click the background in Original to choose the color to remove, or use the color control.'
                  : 'To remove a solid background, turn on Remove background color.'}
              </p>
              <div className="frame-conversion-playback">
                <button
                  className="button subtle"
                  aria-label={playing ? 'Pause conversion preview' : 'Play conversion preview'}
                  disabled={doc.frames.length < 2}
                  onClick={() => setPlaying((value) => !value)}
                >
                  {playing ? <Pause size={15} /> : <Play size={15} />}
                  {playing ? 'Pause' : 'Play'}
                </button>
                <label className="select-field">
                  <span>
                    Frame {frame + 1} of {doc.frames.length} · {doc.frames[frame].duration} ms
                  </span>
                  <input
                    type="range"
                    aria-label="Conversion preview frame"
                    min={0}
                    max={doc.frames.length - 1}
                    value={frame}
                    onChange={(e) => {
                      setPlaying(false);
                      setFrame(+e.target.value);
                    }}
                  />
                </label>
              </div>
              <p className="help-text">
                Frame timing and animation tags stay the same. The pivot scales with pixel size.
                Undo restores the original frames.
              </p>
            </div>
            <div className="frame-conversion-options">
              <section aria-label="Pixel size and colors">
                <h3>Pixel size &amp; colors</h3>
                <p className="help-text">Smaller widths make larger, more visible pixels.</p>
                <div className="frame-size-presets" aria-label="Pixel width presets">
                  {[doc.width, ...[64, 128, 256].filter((width) => width !== doc.width)].map(
                    (width, index) => (
                      <button
                        key={width}
                        className="button subtle"
                        aria-pressed={settings.width === width}
                        onClick={() => {
                          set('width', width);
                          setError('');
                        }}
                      >
                        {index === 0 ? 'Original size' : `${width} px`}
                      </button>
                    ),
                  )}
                </div>
                <label className="text-field frame-width-field">
                  <span>Pixel width</span>
                  <input
                    aria-label="Conversion pixel width"
                    type="number"
                    min={1}
                    max={512}
                    value={widthDraft}
                    aria-invalid={!validWidth}
                    onChange={(e) => {
                      const value = e.target.value,
                        width = +value;
                      setWidthDraft(value);
                      if (Number.isInteger(width) && width >= 1 && width <= 512) {
                        setSettings((s) => ({ ...s, width }));
                        setError('');
                      }
                    }}
                    onBlur={(e) => {
                      const width = +e.target.value;
                      if (Number.isInteger(width) && width >= 1 && width <= 512) {
                        set('width', width);
                        setError('');
                      } else {
                        setError('Pixel width must be a whole number from 1 to 512.');
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                  />
                  <span>px · height adjusts to fit</span>
                </label>
                <div className="frame-conversion-fields">
                  <label className="select-field">
                    <span>Palette</span>
                    <select
                      aria-label="Conversion palette"
                      value={settings.palette}
                      onChange={(e) => {
                        const palette = e.target.value as Settings['palette'];
                        setSettings((s) => ({
                          ...s,
                          palette,
                          dither: palette === 'original' ? 'none' : s.dither,
                        }));
                      }}
                    >
                      <option value="original">Original colors</option>
                      <option value="adaptive">Auto · 16 colors</option>
                      {Object.entries(PALETTES).map(([id, palette]) => (
                        <option key={id} value={id}>
                          {palette.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="select-field">
                    <span>Dithering</span>
                    <select
                      aria-label="Conversion dithering"
                      disabled={settings.palette === 'original'}
                      title={
                        settings.palette === 'original'
                          ? 'Choose a palette to enable dithering.'
                          : undefined
                      }
                      value={settings.dither}
                      onChange={(e) => set('dither', e.target.value as Settings['dither'])}
                    >
                      <option value="none">Off · clean edges</option>
                      <option value="bayer">Bayer</option>
                      <option value="floyd">Floyd–Steinberg</option>
                    </select>
                  </label>
                </div>
                {settings.palette === 'original' && (
                  <p className="help-text">
                    Choose a palette to limit colors and enable dithering.
                  </p>
                )}
              </section>
              <section aria-label="Background removal">
                <label className="frame-background-toggle">
                  <input
                    type="checkbox"
                    checked={settings.alpha === 'key'}
                    onChange={(e) => {
                      set('alpha', e.target.checked ? 'key' : 'preserve');
                      setError('');
                    }}
                  />
                  <span>Remove background color</span>
                </label>
                <p className="help-text">Chroma key makes a solid color transparent.</p>
                {settings.alpha === 'key' && (
                  <div className="frame-conversion-key">
                    <label className="frame-key-color">
                      <span>Background color</span>
                      <input
                        aria-label="Conversion key color"
                        type="color"
                        value={settings.keyColor}
                        onChange={(e) => set('keyColor', e.target.value)}
                      />
                      <output aria-live="polite">{settings.keyColor.toUpperCase()}</output>
                    </label>
                    <label className="select-field">
                      <span>Strength · {settings.keyTolerance}</span>
                      <input
                        aria-label="Conversion key strength"
                        type="range"
                        min={0}
                        max={442}
                        value={settings.keyTolerance}
                        onChange={(e) => set('keyTolerance', +e.target.value)}
                      />
                    </label>
                    <label className="select-field">
                      <span>Edge softness · {settings.keySoftness}</span>
                      <input
                        aria-label="Conversion key softness"
                        type="range"
                        min={0}
                        max={200}
                        value={settings.keySoftness}
                        onChange={(e) => set('keySoftness', +e.target.value)}
                      />
                    </label>
                    <p className="help-text">
                      Raise strength until the background clears. Use softness to smooth the edges.
                    </p>
                  </div>
                )}
              </section>
            </div>
          </fieldset>
        </div>
        <div className="frame-conversion-footer">
          <div className="frame-conversion-feedback">
            {error || preview.error ? (
              <p role="alert">{error || preview.error}</p>
            ) : (
              <p role="status">
                {progress !== null
                  ? `Applying to frame ${progress} of ${doc.frames.length}…`
                  : !validWidth
                    ? 'Enter a pixel width from 1 to 512.'
                    : !changed
                      ? 'Choose a pixel width, a palette, or remove a background.'
                      : `${doc.frames.length} ${doc.frames.length === 1 ? 'frame' : 'frames'} · ${preview.canvas?.width ?? '—'} × ${preview.canvas?.height ?? '—'} px · ${settings.alpha === 'key' ? 'background removed' : 'existing transparency kept'}`}
              </p>
            )}
          </div>
          <div className="dialog-actions">
            <button className="button subtle" onClick={close}>
              Cancel
            </button>
            <button
              className="button primary"
              disabled={!changed || !validWidth || progress !== null || !!preview.error}
              onClick={async () => {
                const abort = new AbortController();
                controller.current = abort;
                setPlaying(false);
                setProgress(0);
                setError('');
                try {
                  onApply(await convertSpriteFrames(doc, settings, abort.signal, setProgress));
                } catch (e) {
                  if (!abort.signal.aborted) {
                    setError(e instanceof Error ? e.message : String(e));
                    setProgress(null);
                  }
                }
              }}
            >
              {doc.frames.length === 1
                ? 'Apply to frame'
                : `Apply to all ${doc.frames.length} frames`}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
