import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Crosshair,
  Film,
  FolderOpen,
  Grid2X2,
  Image as ImageIcon,
  Layers2,
  LoaderCircle,
  Maximize,
  Minus,
  MousePointer2,
  Palette,
  Pause,
  Play,
  Plus,
  RotateCcw,
  ScanLine,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  WandSparkles,
  X,
  Pipette,
  Save,
  Gamepad2,
} from 'lucide-react';
import { defaults, PALETTES, rgbHex, type RGB, type Settings } from './engine';
import {
  demoMedia,
  disposeMedia,
  loadMedia,
  pngBytes,
  renderMedia,
  scaleCanvas,
  seekVideo,
  type Media,
} from './media';
import { desktop, saveBytes, checkUpdates } from './platform';
import { exportVideo, frameTimes, type Progress, type VideoFormat } from './export';
import { emptyStabilization, upsertKeyframe, type Stabilization } from './stabilization';
import type { Update } from '@tauri-apps/plugin-updater';
import { APP_VERSION } from './version';
import { startUpdatePolling } from './updater';
import SpriteStudio from './sprites/SpriteStudio';
import { sampleSprite, type SpriteDocument } from './sprites/model';
import { captureClip, documentFromCanvas } from './sprites/capture';

const timeLabel = (t: number) =>
  `${Math.floor(t / 60)
    .toString()
    .padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  onChange,
  disabled = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="slider-field">
      <span>
        {label}
        <output>
          {value}
          {suffix}
        </output>
      </span>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(+e.target.value)}
        style={{ '--fill': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties}
      />
    </label>
  );
}
function Section({
  title,
  icon,
  children,
  open = true,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  open?: boolean;
}) {
  return (
    <details className="control-section" open={open}>
      <summary>
        {icon}
        <span>{title}</span>
        <ChevronDown size={14} />
      </summary>
      <div className="section-content">{children}</div>
    </details>
  );
}
export default function App() {
  const [workspace, setWorkspace] = useState<'converter' | 'sprites'>('converter');
  const [spriteDoc, setSpriteDoc] = useState<SpriteDocument>(() => sampleSprite());
  const [media, setMedia] = useState<Media>(() => demoMedia());
  const [settings, setSettings] = useState<Settings>({ ...defaults, palette: 'earth' });
  const [tab, setTab] = useState<'image' | 'video'>('image');
  const [view, setView] = useState<'pixel' | 'original'>('pixel');
  const [grid, setGrid] = useState(false),
    [background, setBackground] = useState<'checker' | 'dark' | 'light'>('checker');
  const [zoom, setZoom] = useState(1),
    [scale, setScale] = useState(4);
  const [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false),
    [fps, setFps] = useState(12);
  const [start, setStart] = useState(0),
    [end, setEnd] = useState(0);
  const [stabilization, setStabilization] = useState<Stabilization>(emptyStabilization);
  const [picking, setPicking] = useState<'anchor' | 'color' | null>(null);
  const [palette, setPalette] = useState<RGB[]>([]);
  const [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const [busy, setBusy] = useState<Progress | null>(null),
    [loading, setLoading] = useState(false);
  const [format, setFormat] = useState<VideoFormat>('frames');
  const [showSettings, setShowSettings] = useState(false);
  const [ffmpeg, setFfmpeg] = useState(
    () => localStorage.getItem('pixel-forge.ffmpeg') || 'ffmpeg',
  );
  const [update, setUpdate] = useState<Update | null>(null),
    [updateBusy, setUpdateBusy] = useState(false);
  const [autoUpdates, setAutoUpdates] = useState(
    () => localStorage.getItem('pixel-forge.auto-updates') !== 'false',
  );
  const [updateStatus, setUpdateStatus] = useState('');
  const updateRef = useRef<Update | null>(null);
  useEffect(() => {
    if (!desktop || !autoUpdates) return;
    let active = true;
    const stop = startUpdatePolling(async () => {
      const available = await checkUpdates(() => {}, true);
      if (!active) {
        await available?.close();
        return;
      }
      if (available) {
        await updateRef.current?.close().catch(() => {});
        updateRef.current = available;
        setUpdate(available);
      }
    });
    return () => {
      active = false;
      stop();
    };
  }, [autoUpdates]);
  const [canvasBounds, setCanvasBounds] = useState({ width: 900, height: 490 });
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null),
    processedRef = useRef<HTMLCanvasElement | null>(null);
  const fileRef = useRef<HTMLInputElement>(null),
    presetRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null),
    seekToken = useRef(0);
  const videoMode = media.kind === 'video';
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));
  const lockedPalette = useMemo(() => {
    if (!media.reference) return undefined;
    return renderMedia({ ...media, source: media.reference }, settings).palette;
  }, [media, settings]);

  useEffect(() => {
    const area = canvasAreaRef.current;
    if (!area) return;
    const observer = new ResizeObserver(([entry]) =>
      setCanvasBounds({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(area);
    return () => observer.disconnect();
  }, [workspace]);

  useEffect(() => {
    return () => disposeMedia(media);
  }, [media]);
  useEffect(() => {
    const id = setTimeout(() => setNotice(''), 6500);
    return () => clearTimeout(id);
  }, [notice]);
  useEffect(() => {
    try {
      const rendered = renderMedia(
        media,
        settings,
        lockedPalette,
        videoMode ? stabilization : undefined,
        time,
      );
      processedRef.current = rendered.canvas;
      setPalette(rendered.palette);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const original = view === 'original' || picking !== null;
      canvas.width = original ? Math.min(1200, media.width) : rendered.canvas.width;
      canvas.height = original
        ? Math.round((canvas.width * media.height) / media.width)
        : rendered.canvas.height;
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = original;
      ctx.drawImage(original ? media.source : rendered.canvas, 0, 0, canvas.width, canvas.height);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [media, settings, view, time, lockedPalette, stabilization, videoMode, picking, workspace]);
  useEffect(() => {
    if (!playing || !videoMode) return;
    const video = media.source as HTMLVideoElement;
    let raf = 0;
    video.currentTime = Math.max(start, Math.min(video.currentTime, end));
    const tick = () => {
      if (video.currentTime >= end - 0.015) {
        video.pause();
        setPlaying(false);
        setTime(Math.min(video.currentTime, end));
        return;
      }
      setTime(video.currentTime);
      raf = requestAnimationFrame(tick);
    };
    video
      .play()
      .then(() => {
        raf = requestAnimationFrame(tick);
      })
      .catch((e) => {
        setPlaying(false);
        setError(errorMessage(e));
      });
    return () => {
      cancelAnimationFrame(raf);
      video.pause();
    };
  }, [playing, media, videoMode, start, end]);

  const openFile = useCallback(async (file: File) => {
    setLoading(true);
    setError('');
    setPlaying(false);
    setPicking(null);
    try {
      const loaded = await loadMedia(file);
      setMedia(loaded);
      setTab(loaded.kind);
      setTime(0);
      setStart(0);
      setEnd(loaded.duration);
      setZoom(1);
      setStabilization(emptyStabilization);
      setView('pixel');
      setNotice(
        `${loaded.kind === 'video' ? 'Video' : 'Image'} opened. Everything stays on this device.`,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);
  const seek = async (value: number) => {
    if (!videoMode) return;
    setPlaying(false);
    const token = ++seekToken.current;
    try {
      await seekVideo(
        media.source as HTMLVideoElement,
        Math.max(0, Math.min(value, media.duration - 0.001)),
      );
      if (token === seekToken.current) setTime((media.source as HTMLVideoElement).currentTime);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const exportCurrent = useCallback(async () => {
    if (!processedRef.current || busy) return;
    setError('');
    try {
      const canvas = scaleCanvas(processedRef.current, scale, grid);
      const name = media.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
      if (await saveBytes(await pngBytes(canvas), `${name}-pixel.png`, 'png'))
        setNotice('PNG exported with transparency.');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [media, scale, grid, busy]);
  useEffect(() => {
    if (workspace !== 'converter') return;
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        if (!busy) fileRef.current?.click();
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        void exportCurrent();
      }
      if (event.key === 'Escape') setPicking(null);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [exportCurrent, busy, workspace]);
  const beginVideoExport = async () => {
    setPlaying(false);
    setError('');
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy({ fraction: 0, label: 'Preparing video…' });
    try {
      const saved = await exportVideo(
        media,
        settings,
        palette,
        { fps, start, end, scale, format, ffmpeg },
        stabilization,
        abort.signal,
        setBusy,
      );
      if (saved)
        setNotice(
          format === 'frames'
            ? 'Frame sequence exported. RGBA PNGs and timing manifest are inside.'
            : 'Video exported successfully.',
        );
    } catch (err) {
      if (abort.signal.aborted) setNotice('Export cancelled.');
      else setError(errorMessage(err));
    } finally {
      setBusy(null);
      abortRef.current = null;
    }
  };
  const pickPoint = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!picking) return;
    const canvas = event.currentTarget,
      rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    if (picking === 'color') {
      const data = canvas
        .getContext('2d')!
        .getImageData(
          Math.min(canvas.width - 1, Math.floor(x * canvas.width)),
          Math.min(canvas.height - 1, Math.floor(y * canvas.height)),
          1,
          1,
        ).data;
      setSettings((s) => ({ ...s, alpha: 'key', keyColor: rgbHex([data[0], data[1], data[2]]) }));
      setNotice('Key color sampled from the original frame.');
    } else {
      setStabilization((s) => ({
        ...s,
        enabled: true,
        target: s.keyframes.length ? s.target : { x, y },
        keyframes: upsertKeyframe(s.keyframes, { time, x, y }, fps),
      }));
      setNotice('Anchor keyframe added. Seek forward and mark the same feature again.');
    }
    setPicking(null);
    setView('pixel');
  };
  const savePreset = async () => {
    try {
      await saveBytes(
        new TextEncoder().encode(JSON.stringify({ version: 1, settings }, null, 2)),
        'pixel-forge-preset.json',
        'json',
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const loadPreset = async (file: File) => {
    try {
      const input = JSON.parse(await file.text());
      const s = input.settings;
      if (
        input.version !== 1 ||
        !s ||
        !['original', 'adaptive', 'pico8', 'earth', 'gameboy', 'mono', 'custom'].includes(
          s.palette,
        ) ||
        !['none', 'bayer', 'floyd'].includes(s.dither) ||
        !['preserve', 'threshold', 'key', 'opaque'].includes(s.alpha)
      )
        throw new Error('This is not a Pixel Forge preset.');
      const next = { ...defaults, ...s };
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
      for (const [key, [min, max]] of Object.entries(ranges))
        if (
          typeof next[key] !== 'number' ||
          !Number.isFinite(next[key]) ||
          next[key] < min ||
          next[key] > max
        )
          throw new Error('Preset contains an invalid ' + key + '.');
      if (!/^#[0-9a-f]{6}$/i.test(next.keyColor) || typeof next.customPalette !== 'string')
        throw new Error('Preset contains an invalid color.');
      setSettings(next);
      setNotice('Conversion preset loaded.');
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const checkForUpdate = async () => {
    setUpdateBusy(true);
    try {
      const available = await checkUpdates((status) => {
        setNotice(status);
        setUpdateStatus(status);
      });
      await updateRef.current?.close().catch(() => {});
      updateRef.current = available;
      setUpdate(available);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUpdateBusy(false);
    }
  };
  const installUpdate = async () => {
    if (!update) return;
    setUpdateBusy(true);
    try {
      let total = 0,
        downloaded = 0;
      setUpdateStatus('Downloading update…');
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength ?? 0;
        if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          setUpdateStatus(
            total
              ? `Downloading update… ${Math.round((downloaded / total) * 100)}%`
              : 'Downloading update…',
          );
        }
        if (event.event === 'Finished') setUpdateStatus('Installing update…');
      });
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (err) {
      setError(errorMessage(err));
      setUpdateBusy(false);
    }
  };
  let frameCount = 0;
  try {
    if (videoMode) frameCount = frameTimes(start, end, fps).length;
  } catch {
    /* Validation displayed at export. */
  }
  const outputHeight = Math.round((settings.width * media.height) / media.width);
  const displayOriginal = view === 'original' || picking !== null;
  const chooseMedia = (kind: 'image' | 'video') => {
    setTab(kind);
    if (media.kind !== kind) {
      if (fileRef.current) {
        fileRef.current.accept =
          kind === 'image' ? 'image/png,image/jpeg,image/webp,image/svg+xml' : 'video/*';
        fileRef.current.click();
      }
    }
  };

  const createGameAsset = async () => {
    setPlaying(false);
    setError('');
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy({ fraction: 0, label: 'Preparing game asset…' });
    try {
      const document = videoMode
        ? await captureClip(
            media,
            settings,
            palette,
            stabilization,
            start,
            end,
            fps,
            controller.signal,
            setBusy,
          )
        : documentFromCanvas(processedRef.current!, media.name);
      setSpriteDoc(document);
      setWorkspace('sprites');
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      setBusy(null);
      abortRef.current = null;
    }
  };
  if (workspace === 'sprites')
    return (
      <SpriteStudio
        initial={spriteDoc}
        onChange={setSpriteDoc}
        onBack={() => setWorkspace('converter')}
      />
    );
  return (
    <div
      className="app"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (!busy && event.dataTransfer.files[0]) void openFile(event.dataTransfer.files[0]);
      }}
    >
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        aria-label="Import image or video"
        accept="image/*,video/*"
        onChange={(event) => {
          if (event.target.files?.[0]) void openFile(event.target.files[0]);
          event.target.value = '';
        }}
      />
      <input
        ref={presetRef}
        type="file"
        className="hidden"
        accept=".json"
        onChange={(event) => {
          if (event.target.files?.[0]) void loadPreset(event.target.files[0]);
          event.target.value = '';
        }}
      />
      <header className="topbar">
        <a className="brand" href="#" onClick={(e) => e.preventDefault()}>
          <span className="brand-mark">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
          pixel<span className="brand-light">forge</span>
          <span className="version">BETA</span>
        </a>
        <div className="header-divider" />
        <div className="workspace-name">Local workspace</div>
        <div className="topbar-right">
          <button
            className="button subtle small game-assets-button"
            aria-label="Game assets"
            disabled={!!busy}
            onClick={() => {
              setPlaying(false);
              setWorkspace('sprites');
            }}
          >
            <Gamepad2 size={15} /> Game assets
          </button>
          {update && (
            <button className="button primary small" onClick={() => setShowSettings(true)}>
              Update {update.version}
            </button>
          )}
          <span className="local-badge">
            <span /> Local processing
          </span>
          <button
            className="icon-button"
            aria-label="App settings"
            onClick={() => setShowSettings(true)}
          >
            <Settings2 size={18} />
          </button>
          <button
            className="button subtle small"
            onClick={() => {
              if (fileRef.current) fileRef.current.accept = 'image/*,video/*';
              fileRef.current?.click();
            }}
            disabled={!!busy}
          >
            <FolderOpen size={15} /> Open file <kbd>⌘ O</kbd>
          </button>
        </div>
      </header>
      <div className="app-body">
        <nav className="tool-rail" aria-label="Workspace tools">
          <button
            title="Image studio"
            aria-label="Image studio"
            className={tab === 'image' ? 'active' : ''}
            onClick={() => chooseMedia('image')}
            disabled={!!busy}
          >
            <ImageIcon size={21} />
          </button>
          <button
            title="Video studio"
            aria-label="Video studio"
            className={tab === 'video' ? 'active' : ''}
            onClick={() => chooseMedia('video')}
            disabled={!!busy}
          >
            <Film size={21} />
          </button>
          <span className="rail-rule" />
          <button
            title="Palette controls"
            aria-label="Palette controls"
            onClick={() =>
              document
                .getElementById('palette-section')
                ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
            }
          >
            <Palette size={20} />
          </button>
          <button
            title="Chroma key controls"
            aria-label="Chroma key controls"
            onClick={() => {
              const e = document.getElementById('alpha-section');
              e?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              e?.querySelector('details')?.setAttribute('open', '');
            }}
          >
            <Layers2 size={20} />
          </button>
          <div className="rail-bottom">
            <button
              title="App settings"
              aria-label="Settings"
              onClick={() => setShowSettings(true)}
            >
              <SlidersHorizontal size={20} />
            </button>
            <div className="rail-avatar">pf</div>
          </div>
        </nav>
        <main className="workspace">
          <div className="workspace-heading">
            <div>
              <div className="eyebrow">
                <span /> PIXEL FORGE
              </div>
              <h1>{videoMode ? 'Video editor' : 'Image editor'}</h1>
              <p>
                {media.width} × {media.height} source
                {videoMode ? ` · ${timeLabel(media.duration)} duration` : ' · PNG, JPEG, WebP, SVG'}
              </p>
            </div>
            <button
              className="button import-button"
              onClick={() => {
                if (fileRef.current) fileRef.current.accept = 'image/*,video/*';
                fileRef.current?.click();
              }}
              disabled={!!busy}
            >
              <Plus size={17} /> Import media
            </button>
          </div>
          <div className="editor">
            <div className="editor-toolbar">
              <div className="file-title">
                {videoMode ? <Film size={15} /> : <ImageIcon size={15} />}
                <span>{media.name}</span>
                <span className="file-type">{videoMode ? 'VIDEO' : 'IMAGE'}</span>
              </div>
              <div className="preview-switch" aria-label="Preview mode">
                <button
                  className={!displayOriginal ? 'selected' : ''}
                  onClick={() => {
                    setView('pixel');
                    setPicking(null);
                  }}
                >
                  Pixel art
                </button>
                <button
                  className={displayOriginal ? 'selected' : ''}
                  onClick={() => setView('original')}
                >
                  Original
                </button>
              </div>
              <button
                className={`icon-button ${grid ? 'is-on' : ''}`}
                title="Toggle pixel grid"
                aria-label="Toggle pixel grid"
                aria-pressed={grid}
                onClick={() => setGrid(!grid)}
              >
                <Grid2X2 size={17} />
              </button>
            </div>
            <div
              ref={canvasAreaRef}
              className={`canvas-area background-${background} ${picking ? 'picking' : ''}`}
            >
              <div className="canvas-corner top-left" />
              <div className="canvas-corner bottom-right" />
              <div
                className="canvas-art"
                style={{
                  width:
                    Math.min(
                      canvasBounds.width * 0.82,
                      ((canvasBounds.height - 64) * media.width) / media.height,
                      680,
                    ) * zoom,
                  aspectRatio: `${media.width}/${media.height}`,
                }}
              >
                <canvas
                  ref={canvasRef}
                  onClick={pickPoint}
                  className={displayOriginal ? 'original' : ''}
                  aria-label="Media preview"
                />
                {grid && !displayOriginal && (
                  <div
                    className="pixel-grid"
                    style={{ backgroundSize: `${100 / settings.width}% ${100 / outputHeight}%` }}
                  />
                )}
                {videoMode &&
                  stabilization.enabled &&
                  stabilization.keyframes.length > 0 &&
                  !displayOriginal && (
                    <div
                      className="anchor-marker"
                      style={{
                        left: `${stabilization.target.x * 100}%`,
                        top: `${stabilization.target.y * 100}%`,
                      }}
                    >
                      <Crosshair size={32} />
                      <span>STATIONARY ANCHOR</span>
                    </div>
                  )}
                <div className="art-dimension">
                  {displayOriginal
                    ? `${media.width} × ${media.height}`
                    : `${settings.width} × ${outputHeight}`}{' '}
                  px
                </div>
              </div>
              {picking && (
                <div className="pick-instruction">
                  {picking === 'anchor' ? <Crosshair size={16} /> : <Pipette size={16} />}{' '}
                  {picking === 'anchor'
                    ? 'Click a feature to keep stationary'
                    : 'Click the background color to remove'}
                  <button aria-label="Cancel picking" onClick={() => setPicking(null)}>
                    <X size={15} />
                  </button>
                </div>
              )}
              {loading && (
                <div className="loading-overlay">
                  <LoaderCircle className="spin" /> Opening media…
                </div>
              )}
              {tab === 'video' && !videoMode && (
                <div className="video-invite">
                  <Film size={25} />
                  <b>Open video</b>
                  <span>
                    Import a video to edit frames, set stabilization anchors, and export an
                    animation.
                  </span>
                  <button className="button primary" onClick={() => chooseMedia('video')}>
                    Open a video <ArrowRight size={15} />
                  </button>
                  <button className="text-button" onClick={() => setTab('image')}>
                    Return to image studio
                  </button>
                </div>
              )}
            </div>
            <div className="canvas-bottom">
              <div className="canvas-status">
                <span className="status-dot" />
                {displayOriginal
                  ? 'Original preview'
                  : `${palette.length || 'Full'} colors · ${settings.width} × ${outputHeight} pixels`}
              </div>
              <div className="canvas-view-controls">
                <button
                  title="Change preview background"
                  aria-label="Change preview background"
                  className={`background-swatch ${background}`}
                  onClick={() =>
                    setBackground(
                      background === 'checker'
                        ? 'dark'
                        : background === 'dark'
                          ? 'light'
                          : 'checker',
                    )
                  }
                />
                <span className="thin-divider" />
                <button
                  className="icon-button"
                  aria-label="Zoom out"
                  onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}
                >
                  <Minus size={14} />
                </button>
                <span>{Math.round(zoom * 100)}%</span>
                <button
                  className="icon-button"
                  aria-label="Zoom in"
                  onClick={() => setZoom(Math.min(2, zoom + 0.25))}
                >
                  <Plus size={14} />
                </button>
                <button className="icon-button" aria-label="Fit canvas" onClick={() => setZoom(1)}>
                  <Maximize size={14} />
                </button>
              </div>
            </div>
          </div>
          {videoMode ? (
            <div className="timeline">
              <div className="timeline-heading">
                <div className="transport">
                  <button
                    className="icon-button"
                    aria-label="Previous frame"
                    onClick={() => void seek(time - 1 / fps)}
                    disabled={!!busy}
                  >
                    <ArrowLeft size={15} />
                  </button>
                  <button
                    className="play-button"
                    aria-label={playing ? 'Pause video' : 'Play video'}
                    onClick={() => {
                      if (time >= end - 0.05) void seek(start).then(() => setPlaying(true));
                      else setPlaying(!playing);
                    }}
                    disabled={!!busy}
                  >
                    {playing ? <Pause size={17} /> : <Play size={17} />}
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Next frame"
                    onClick={() => void seek(time + 1 / fps)}
                    disabled={!!busy}
                  >
                    <ArrowRight size={15} />
                  </button>
                  <span className="timecode">
                    {timeLabel(time)}
                    <i>/</i>
                    {timeLabel(media.duration)}
                  </span>
                </div>
                <div className="timeline-actions">
                  <button
                    className={`button small ${picking === 'anchor' ? 'primary' : 'subtle'}`}
                    onClick={() => {
                      setPlaying(false);
                      setPicking('anchor');
                    }}
                    disabled={!!busy}
                  >
                    <Crosshair size={14} /> Set anchor
                  </button>
                  <span className="frame-count">{frameCount.toLocaleString()} frames</span>
                </div>
              </div>
              <div className="timeline-track">
                <div className="timeline-ruler">
                  {Array.from({ length: 7 }, (_, i) => (
                    <span key={i}>{timeLabel((media.duration * i) / 6)}</span>
                  ))}
                </div>
                <div className="clip-track">
                  <Film size={13} />
                  <span>{media.name}</span>
                  <div
                    className="trim-shade"
                    style={{ width: `${(start / media.duration) * 100}%` }}
                  />
                  <div
                    className="trim-shade right"
                    style={{ width: `${((media.duration - end) / media.duration) * 100}%` }}
                  />
                </div>
                <div className="anchor-track">
                  <Crosshair size={12} />
                  <span>Anchor</span>
                  {stabilization.keyframes.map((k) => (
                    <button
                      key={k.time}
                      title={`Anchor at ${timeLabel(k.time)}`}
                      aria-label={`Seek to anchor at ${timeLabel(k.time)}`}
                      style={{ left: `${(k.time / media.duration) * 100}%` }}
                      onClick={() => void seek(k.time)}
                    />
                  ))}
                </div>
                <input
                  className="timeline-scrubber"
                  aria-label="Video timeline"
                  type="range"
                  min="0"
                  max={media.duration}
                  step={1 / fps}
                  value={time}
                  onChange={(e) => void seek(+e.target.value)}
                  disabled={!!busy}
                />
                <div className="playhead" style={{ left: `${(time / media.duration) * 100}%` }} />
              </div>
              <p className="timeline-hint">
                <MousePointer2 size={12} /> Seek to a frame, then set an anchor on the same feature.
                Positions interpolate between keyframes.
              </p>
            </div>
          ) : (
            <div className="workshop-note">
              <span className="note-icon">
                <ImageIcon size={18} />
              </span>
              <div>
                <b>Image conversion</b>
                <p>
                  Adjust resolution, palette, and transparency. Drag a file here to replace the
                  source.
                </p>
              </div>
              <span className="note-shortcut">PNG · JPG · WEBP · VIDEO</span>
            </div>
          )}
          <div className="workspace-footer">
            <span>
              <ShieldCheck size={13} /> Processed on your device
            </span>
            <span>
              v{APP_VERSION} · {desktop ? 'Desktop' : 'Browser preview'}
            </span>
            <button
              onClick={() => {
                setPlaying(false);
                setMedia(demoMedia());
                setTab('image');
                setTime(0);
                setStabilization(emptyStabilization);
              }}
            >
              Load sample <ArrowRight size={12} />
            </button>
          </div>
        </main>
        <aside className="inspector">
          <div className="inspector-title">
            <SlidersHorizontal size={16} />
            <h2>Conversion settings</h2>
            <button
              className="icon-button"
              aria-label="Reset adjustments"
              title="Reset adjustments"
              disabled={!!busy}
              onClick={() => {
                setSettings({ ...defaults, palette: 'earth' });
                setNotice('Conversion settings reset.');
              }}
            >
              <RotateCcw size={15} />
            </button>
          </div>
          <div className="controls-scroll">
            <fieldset className="controls-fields" disabled={!!busy || loading}>
              <Section title="Resolution" icon={<ScanLine size={15} />}>
                <Slider
                  label="Pixel width"
                  value={settings.width}
                  min={8}
                  max={512}
                  suffix=" px"
                  onChange={(v) => set('width', v)}
                />
                <div className="size-presets">
                  {[32, 64, 128, 256].map((n) => (
                    <button
                      key={n}
                      className={settings.width === n ? 'active' : ''}
                      onClick={() => set('width', n)}
                    >
                      {n} px
                    </button>
                  ))}
                </div>
                <div className="info-line">
                  <span>Aspect ratio locked</span>
                  <span>
                    {settings.width} × {outputHeight}
                  </span>
                </div>
              </Section>
              <div id="palette-section">
                <Section title="Color palette" icon={<Palette size={15} />}>
                  <label className="select-field">
                    <span>Palette</span>
                    <select
                      aria-label="Color palette"
                      value={settings.palette}
                      onChange={(e) => set('palette', e.target.value as Settings['palette'])}
                    >
                      <option value="original">Original colors</option>
                      <option value="adaptive">Auto · from source</option>
                      {Object.entries(PALETTES).map(([id, p]) => (
                        <option key={id} value={id}>
                          {p.name} · {p.colors.length} colors
                        </option>
                      ))}
                      <option value="custom">Custom hex palette</option>
                    </select>
                  </label>
                  {settings.palette === 'adaptive' && (
                    <>
                      <Slider
                        label="Maximum colors"
                        value={settings.colors}
                        min={2}
                        max={64}
                        onChange={(v) => set('colors', v)}
                      />
                      {videoMode && (
                        <p className="help-text">
                          Palette is locked to the first source frame to reduce color flicker.
                        </p>
                      )}
                    </>
                  )}
                  {settings.palette === 'custom' && (
                    <label className="text-field">
                      <span>Colors as #RRGGBB</span>
                      <textarea
                        aria-label="Custom palette colors"
                        value={settings.customPalette}
                        onChange={(e) => set('customPalette', e.target.value)}
                      />
                    </label>
                  )}
                  <div className="palette-swatches">
                    {palette.slice(0, 32).map((p, i) => (
                      <span key={i} style={{ background: rgbHex(p) }} title={rgbHex(p)} />
                    ))}
                  </div>
                  <label className="select-field">
                    <span>Dithering</span>
                    <select
                      aria-label="Dithering"
                      value={settings.dither}
                      onChange={(e) => set('dither', e.target.value as Settings['dither'])}
                    >
                      <option value="none">Off · clean edges</option>
                      <option value="bayer">Bayer · ordered texture</option>
                      <option value="floyd">Floyd–Steinberg</option>
                    </select>
                  </label>
                  {settings.dither !== 'none' && (
                    <Slider
                      label="Dither amount"
                      value={settings.ditherStrength}
                      min={0}
                      max={100}
                      suffix="%"
                      onChange={(v) => set('ditherStrength', v)}
                    />
                  )}
                </Section>
              </div>
              <Section title="Fine adjustments" icon={<WandSparkles size={15} />} open={false}>
                <Slider
                  label="Brightness"
                  value={settings.brightness}
                  min={-100}
                  max={100}
                  onChange={(v) => set('brightness', v)}
                />
                <Slider
                  label="Contrast"
                  value={settings.contrast}
                  min={-100}
                  max={100}
                  onChange={(v) => set('contrast', v)}
                />
                <Slider
                  label="Saturation"
                  value={settings.saturation}
                  min={-100}
                  max={100}
                  onChange={(v) => set('saturation', v)}
                />
              </Section>
              <div id="alpha-section">
                <Section title="Transparency & chroma key" icon={<Layers2 size={15} />}>
                  <label className="select-field">
                    <span>Alpha mode</span>
                    <select
                      aria-label="Alpha mode"
                      value={settings.alpha}
                      onChange={(e) => set('alpha', e.target.value as Settings['alpha'])}
                    >
                      <option value="preserve">Preserve source alpha</option>
                      <option value="key">Chroma key · remove a color</option>
                      <option value="threshold">Hard alpha · sprite edges</option>
                      <option value="opaque">Make opaque</option>
                    </select>
                  </label>
                  {settings.alpha === 'key' && (
                    <>
                      <div className="key-color-row">
                        <label>
                          Key color{' '}
                          <input
                            aria-label="Key color"
                            type="color"
                            value={settings.keyColor}
                            onChange={(e) => set('keyColor', e.target.value)}
                          />
                          <span>{settings.keyColor.toUpperCase()}</span>
                        </label>
                        <button
                          className={`icon-button ${picking === 'color' ? 'is-on' : ''}`}
                          aria-label="Sample key color"
                          title="Sample from original"
                          onClick={() => {
                            setPlaying(false);
                            setPicking('color');
                          }}
                        >
                          <Pipette size={16} />
                        </button>
                      </div>
                      <Slider
                        label="Key strength"
                        value={settings.keyTolerance}
                        min={0}
                        max={442}
                        onChange={(v) => set('keyTolerance', v)}
                      />
                      <Slider
                        label="Edge softness"
                        value={settings.keySoftness}
                        min={0}
                        max={200}
                        onChange={(v) => set('keySoftness', v)}
                      />
                      <p className="help-text">
                        Sample the original background, then raise strength until it disappears.
                        Softness feathers the edge.
                      </p>
                    </>
                  )}
                  {settings.alpha === 'threshold' && (
                    <Slider
                      label="Alpha cutoff"
                      value={settings.alphaThreshold}
                      min={0}
                      max={255}
                      onChange={(v) => set('alphaThreshold', v)}
                    />
                  )}
                  <div className="alpha-note">
                    <span className="mini-checker" /> RGBA transparency supported
                  </div>
                  {videoMode && (
                    <p className="help-text">
                      Video alpha depends on the source codec and system decoder. Color key can
                      create alpha from a solid background.
                    </p>
                  )}
                </Section>
              </div>
              {videoMode && (
                <>
                  <Section title="Anchor stabilization" icon={<Crosshair size={15} />}>
                    <label className="toggle-label">
                      <input
                        aria-label="Enable stabilization"
                        type="checkbox"
                        checked={stabilization.enabled}
                        onChange={(e) =>
                          setStabilization((s) => ({ ...s, enabled: e.target.checked }))
                        }
                      />{' '}
                      Stabilize around anchor
                    </label>
                    <p className="help-text">
                      Mark the same feature on multiple frames. The first marker becomes the
                      stationary target. Transparent edges show the frame movement.
                    </p>
                    <button
                      className="button subtle full"
                      onClick={() => {
                        setPlaying(false);
                        setPicking('anchor');
                      }}
                    >
                      <Crosshair size={14} />{' '}
                      {stabilization.keyframes.length
                        ? 'Add anchor keyframe'
                        : 'Place stationary marker'}
                    </button>
                    <Slider
                      label="Stabilization zoom"
                      min={1}
                      max={2}
                      step={0.05}
                      suffix="×"
                      value={stabilization.zoom}
                      onChange={(v) => setStabilization((s) => ({ ...s, zoom: v }))}
                    />
                    <div className="keyframe-list">
                      {stabilization.keyframes.map((k) => (
                        <div key={k.time}>
                          <button className="text-button" onClick={() => void seek(k.time)}>
                            <span className="key-diamond" /> {timeLabel(k.time)}
                          </button>
                          <button
                            className="icon-button"
                            aria-label={`Remove anchor at ${timeLabel(k.time)}`}
                            onClick={() =>
                              setStabilization((s) => ({
                                ...s,
                                keyframes: s.keyframes.filter((f) => f.time !== k.time),
                              }))
                            }
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                    {stabilization.keyframes.length > 0 && (
                      <button
                        className="text-button muted"
                        onClick={() => setStabilization(emptyStabilization)}
                      >
                        Clear anchor track
                      </button>
                    )}
                  </Section>
                  <Section title="Clip & timing" icon={<Film size={15} />}>
                    <div className="trim-inputs">
                      <label>
                        In (seconds)
                        <input
                          aria-label="Trim start"
                          type="number"
                          min="0"
                          max={end}
                          step="0.01"
                          value={start}
                          onChange={(e) =>
                            setStart(Math.max(0, Math.min(end - 0.01, +e.target.value)))
                          }
                        />
                      </label>
                      <label>
                        Out (seconds)
                        <input
                          aria-label="Trim end"
                          type="number"
                          min={start}
                          max={media.duration}
                          step="0.01"
                          value={end}
                          onChange={(e) =>
                            setEnd(
                              Math.min(media.duration, Math.max(start + 0.01, +e.target.value)),
                            )
                          }
                        />
                      </label>
                    </div>
                    <label className="select-field">
                      <span>Export frame rate</span>
                      <select
                        aria-label="Export frame rate"
                        value={fps}
                        onChange={(e) => setFps(+e.target.value)}
                      >
                        {[6, 8, 12, 15, 24, 30, 60].map((n) => (
                          <option key={n} value={n}>
                            {n} FPS
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="help-text">
                      Exports sample every 1 / FPS seconds. Up to 1,800 frames per export. Silent
                      output.
                    </p>
                  </Section>
                </>
              )}
              <div className="preset-row">
                <button className="text-button" onClick={() => void savePreset()}>
                  <Save size={13} /> Save preset
                </button>
                <button className="text-button" onClick={() => presetRef.current?.click()}>
                  Load preset <ChevronRight size={12} />
                </button>
              </div>
            </fieldset>
          </div>
          <div className="export-panel">
            <div className="export-heading">
              <span>EXPORT</span>
              <span className="png-badge">{videoMode ? 'MOTION' : 'PNG'}</span>
            </div>
            <label className="select-field">
              <span>Export scale</span>
              <select
                aria-label="Export scale"
                value={scale}
                onChange={(e) => setScale(+e.target.value)}
                disabled={!!busy}
              >
                {[1, 2, 4, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}× · {settings.width * n} × {outputHeight * n} px
                  </option>
                ))}
              </select>
            </label>
            {videoMode && (
              <label className="select-field">
                <span>Format</span>
                <select
                  aria-label="Video export format"
                  value={format}
                  onChange={(e) => setFormat(e.target.value as VideoFormat)}
                  disabled={!!busy}
                >
                  <option value="frames">RGBA PNG sequence (.zip)</option>
                  <option value="webm" disabled={!desktop}>
                    WebM · VP9 alpha (FFmpeg)
                  </option>
                  <option value="mov" disabled={!desktop}>
                    MOV · ProRes 4444 (FFmpeg)
                  </option>
                </select>
              </label>
            )}
            {busy ? (
              <div className="export-progress">
                <div>
                  <LoaderCircle className="spin" size={14} />
                  <span>{busy.label}</span>
                </div>
                <progress max="1" value={busy.fraction} />
                <button
                  className="text-button"
                  disabled={busy.encoding}
                  onClick={() => abortRef.current?.abort()}
                >
                  Cancel export
                </button>
              </div>
            ) : (
              <>
                <button
                  className="button primary export-button"
                  onClick={() => void (videoMode ? beginVideoExport() : exportCurrent())}
                  disabled={loading}
                >
                  <ArrowDownToLine size={16} />
                  {videoMode ? 'Export animation' : 'Export image'}
                  <ArrowRight size={16} />
                </button>
                {videoMode ? (
                  <button className="text-button export-frame" onClick={() => void exportCurrent()}>
                    Export this frame as PNG
                  </button>
                ) : (
                  <p className="export-note">PNG · nearest-neighbor scaling · RGBA</p>
                )}
                <button
                  className="button subtle full"
                  disabled={loading}
                  onClick={() => void createGameAsset()}
                >
                  <Gamepad2 size={14} />
                  {videoMode ? 'Create sprite animation' : 'Edit as game sprite'}
                </button>
              </>
            )}
          </div>
        </aside>
      </div>
      {(notice || error) && (
        <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
          {error ? <X size={16} /> : <Check size={16} />}
          <span>{error || notice}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => {
              setError('');
              setNotice('');
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="App settings"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <div className="eyebrow">PIXEL FORGE · {APP_VERSION}</div>
                <h2>App settings</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close settings"
                onClick={() => setShowSettings(false)}
              >
                <X size={19} />
              </button>
            </div>
            <h3>Native video encoding</h3>
            <p>
              Desktop WebM and ProRes exports use a separately installed FFmpeg executable. PNG
              sequences work without it. Video preview uses your system’s supported codecs.
            </p>
            <label className="text-field">
              <span>FFmpeg executable path</span>
              <input
                aria-label="FFmpeg executable path"
                value={ffmpeg}
                onChange={(e) => {
                  setFfmpeg(e.target.value);
                  localStorage.setItem('pixel-forge.ffmpeg', e.target.value);
                }}
                placeholder="ffmpeg or full executable path"
              />
            </label>
            <p className="help-text">
              macOS example: /opt/homebrew/bin/ffmpeg
              <br />
              Windows example: C:\ffmpeg\bin\ffmpeg.exe
            </p>
            <hr />
            <h3>Application updates</h3>
            <p>
              Updates come from published releases of ooberguts/pixel-forge on GitHub. Downloads are
              verified before installation. Install & restart closes the current editing session.
            </p>
            <label className="toggle-label update-toggle">
              <input
                type="checkbox"
                aria-label="Automatically check for updates"
                checked={autoUpdates}
                onChange={(e) => {
                  setAutoUpdates(e.target.checked);
                  localStorage.setItem('pixel-forge.auto-updates', String(e.target.checked));
                }}
              />
              Check on startup and every 6 hours
            </label>
            <button
              className="button subtle"
              disabled={updateBusy}
              onClick={() => void checkForUpdate()}
            >
              {updateBusy ? <LoaderCircle size={15} className="spin" /> : <RotateCcw size={15} />}
              Check for updates
            </button>
            {updateStatus && (
              <p className="help-text" role="status">
                {updateStatus}
              </p>
            )}
            {update && (
              <div className="update-card">
                <b>Version {update.version} is available</b>
                <p>{update.body || 'A new release is ready.'}</p>
                <button
                  className="button primary"
                  disabled={updateBusy || !!busy || playing}
                  onClick={() => void installUpdate()}
                >
                  Install & restart
                </button>
              </div>
            )}
            <hr />
            <div className="settings-bottom">
              <span>
                <ShieldCheck size={14} /> Local media processing
              </span>
              <span>{desktop ? 'Tauri desktop' : 'Browser preview'}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
