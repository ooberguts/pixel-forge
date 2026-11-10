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
} from 'lucide-react';
import { defaults, PALETTES, rgbHex, type RGB, type Settings } from './engine';
import {
  demoMedia,
  disposeMedia,
  loadMedia,
  pngBytes,
  renderMedia,
  scaleCanvas,
  seekMedia,
  mediaFromAnimation,
  type Media,
} from './media';
import { desktop, saveBytes, checkUpdates } from './platform';
import { exportVideo, frameTimes, type Progress, type VideoFormat } from './export';
import { emptyStabilization, upsertKeyframe, type Stabilization } from './stabilization';
import type { Update } from '@tauri-apps/plugin-updater';
import { APP_VERSION } from './version';
import { startUpdatePolling } from './updater';
import SpriteStudio from './sprites/SpriteStudio';
import { Dialog, useConfirmation } from './Dialogs';
import { sampleSprite, type SpriteDocument } from './sprites/model';
import { captureClip, documentFromCanvas } from './sprites/capture';
import { animationTimeline, adjacentAnimationTime } from './animationTiming';
import { flushSync } from 'react-dom';
import { validateSettings, validateTrim } from './converterSettings';
import {
  useAutomationBridge,
  useAutomationHandlers,
  executeAutomationCommand,
  checkAutomationContext,
} from './automation/bridge';
import { assertParams, base64ToBytes, bytesToBase64, integer } from './automation/data';
import AutomationPanel from './automation/AutomationPanel';

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
type SourceSnapshot = {
  media: Media;
  settings: Settings;
  start: number;
  end: number;
  time: number;
  fps: number;
  scale: number;
  format: VideoFormat;
  stabilization: Stabilization;
  sample: boolean;
};

export default function App() {
  useAutomationBridge(desktop);
  const [workspace, setWorkspace] = useState<'converter' | 'sprites'>('converter');
  const [spriteDoc, setSpriteDoc] = useState<SpriteDocument>(() => sampleSprite());
  const [spriteRevision, setSpriteRevision] = useState(0);
  const [spriteOrigin, setSpriteOrigin] = useState<'sample' | 'converter' | 'gif'>('sample');
  const [spriteHasWork, setSpriteHasWork] = useState(false);
  const [spriteDirty, setSpriteDirty] = useState(false);
  const { confirm, confirmation } = useConfirmation();
  const [includeGrid, setIncludeGrid] = useState(false);
  const [sample, setSample] = useState(true);
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const [media, setMedia] = useState<Media>(() => demoMedia());
  const [settings, setSettings] = useState<Settings>({ ...defaults, palette: 'earth' });
  const [propertyPanel, setPropertyPanel] = useState<
    'appearance' | 'background' | 'timing' | 'export'
  >('appearance');
  const showProperties = (panel: typeof propertyPanel, sectionId?: string) => {
    flushSync(() => setPropertyPanel(panel));
    if (sectionId) {
      const section = document.getElementById(sectionId);
      section?.querySelector('details')?.setAttribute('open', '');
      section?.scrollIntoView({ block: 'nearest' });
    }
  };
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
  const [jobKind, setJobKind] = useState<'export' | 'transfer'>('export');
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
  const pipeline = useRef<{
    original?: SourceSnapshot;
    link?: { media: Media; signature: string; doc: SpriteDocument };
  }>({});
  const activePropertyPanel =
    propertyPanel === 'timing' && media.kind !== 'video' ? 'appearance' : propertyPanel;
  const sourceSignature = JSON.stringify({ settings, start, end, fps, stabilization });
  const matchingFrames =
    pipeline.current.link?.media === media && pipeline.current.link?.signature === sourceSignature;
  const snapshot = (): SourceSnapshot => ({
    media,
    settings,
    start,
    end,
    time,
    fps,
    scale,
    format,
    stabilization,
    sample,
  });
  const restoreSource = (saved: SourceSnapshot) => {
    setPlaying(false);
    setMedia(saved.media);
    setSettings(saved.settings);
    setStart(saved.start);
    setEnd(saved.end);
    setTime(saved.time);
    setFps(saved.fps);
    setScale(saved.scale);
    setFormat(saved.format);
    setStabilization(saved.stabilization);
    setSample(saved.sample);

    setView('pixel');
    setZoom(1);
  };
  const returnToAdjustments = () => {
    if (spriteHasWork && pipeline.current.link?.doc !== spriteDoc) {
      if (!pipeline.current.original) pipeline.current.original = snapshot();
      const source = mediaFromAnimation(spriteDoc);
      const nextSettings = {
        ...defaults,
        width: spriteDoc.width,
        palette: 'original' as const,
        dither: 'none' as const,
      };
      setMedia(source);
      setSettings(nextSettings);
      setStart(0);
      setEnd(source.duration);
      setTime(0);
      setStabilization(emptyStabilization);
      setScale(1);
      setSample(false);

      setView('pixel');
      setZoom(1);
      pipeline.current.link = {
        media: source,
        doc: spriteDoc,
        signature: JSON.stringify({
          settings: nextSettings,
          start: 0,
          end: source.duration,
          fps,
          stabilization: emptyStabilization,
        }),
      };
      setNotice('Your edited frames are now the adjustment source. The original source is kept.');
    }
    setWorkspace('converter');
  };
  const videoMode = media.kind === 'video';
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));
  const lockedPalette = useMemo(() => {
    if (!media.reference) return undefined;
    return renderMedia({ ...media, animation: undefined, source: media.reference }, settings)
      .palette;
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
    return () => {
      if (pipeline.current.original?.media !== media) disposeMedia(media);
    };
  }, [media]);
  useEffect(() => {
    const id = setTimeout(() => setNotice(''), 6500);
    return () => clearTimeout(id);
  }, [notice]);
  useEffect(() => {
    if (workspace !== 'converter') return;
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
    let raf = 0;
    if (media.animation) {
      const began = performance.now(),
        initialTime = Math.max(start, Math.min(time, end));
      const tick = () => {
        const next = Math.min(end, initialTime + (performance.now() - began) / 1000);
        setTime(next);
        if (next >= end) setPlaying(false);
        else raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }
    const video = media.source as HTMLVideoElement;
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

  const chooseFile = () => {
    if (loading || busy) return;
    if (fileRef.current) fileRef.current.accept = 'image/*,video/*';
    fileRef.current?.click();
  };
  const openFile = async (file: File) => {
    if (loading || busy) return;
    if (
      !sample &&
      !(await confirm({
        title: 'Replace source media?',
        description:
          'This replaces the source and resets its trim and stabilization markers. Your frame edits are kept until you choose to replace them.',
        action: 'Replace source',
      }))
    )
      return;
    setLoading(true);
    setError('');
    setPlaying(false);
    setPicking(null);
    try {
      const loaded = await loadMedia(file);
      if (pipeline.current.original) disposeMedia(pipeline.current.original.media);
      pipeline.current.original = undefined;
      pipeline.current.link = undefined;
      setMedia(loaded);
      if (loaded.animation) {
        setSettings({ ...defaults, width: loaded.width, palette: 'original', dither: 'none' });
        setScale(1);
        setFormat('gif');
      }
      setSample(false);

      setTime(0);
      setStart(0);
      setEnd(loaded.duration);
      setZoom(1);
      setStabilization(emptyStabilization);
      setView('pixel');
      setWorkspace('converter');
      setNotice(
        `${loaded.animation ? 'Animation' : loaded.kind === 'video' ? 'Video' : 'Image'} opened. Adjust it, edit frames if needed, then choose an output format.`,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  const seek = async (value: number) => {
    if (!videoMode) return;
    setPlaying(false);
    const token = ++seekToken.current;
    try {
      const next = Math.max(start, Math.min(value, end));
      await seekMedia(media, next);
      if (token === seekToken.current) setTime(next);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const stepFrame = (direction: -1 | 1) =>
    seek(
      media.animation
        ? adjacentAnimationTime(media.animation, time, direction, start, end)
        : time + direction / fps,
    );
  const exportCurrent = useCallback(async () => {
    if (!processedRef.current || busy || loading) return;
    setError('');
    try {
      const canvas = scaleCanvas(
        renderMedia(media, settings, lockedPalette, stabilization, time).canvas,
        scale,
        includeGrid,
      );
      const name = media.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
      if (await saveBytes(await pngBytes(canvas), `${name}-pixel.png`, 'png'))
        setNotice(
          `PNG exported · ${canvas.width} × ${canvas.height} px${includeGrid && scale >= 4 ? ' · grid included' : ''}.`,
        );
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [media, settings, lockedPalette, stabilization, time, scale, includeGrid, busy, loading]);
  useEffect(() => {
    if (workspace !== 'converter' || showSettings) return;
    const listener = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        if (!busy && !loading) {
          if (fileRef.current) fileRef.current.accept = 'image/*,video/*';
          fileRef.current?.click();
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        void exportCurrent();
      }
      if (event.key === 'Escape') setPicking(null);
      if (event.metaKey || event.ctrlKey || event.altKey || busy || loading) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('input, select, textarea, button, summary, [contenteditable]')
      )
        return;
      if (videoMode && event.code === 'Space') {
        event.preventDefault();
        if (time >= end - 0.05) void seek(start).then(() => setPlaying(true));
        else setPlaying((p) => !p);
      }
      if (videoMode && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        void stepFrame(event.key === 'ArrowRight' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [
    exportCurrent,
    busy,
    loading,
    workspace,
    showSettings,
    videoMode,
    media,
    time,
    end,
    start,
    fps,
  ]);
  const beginVideoExport = async () => {
    if (['gif', 'pack'].includes(format) && transferIssue) {
      setError(transferIssue);
      return;
    }
    setPlaying(false);
    setError('');
    const abort = new AbortController();
    abortRef.current = abort;
    setJobKind('export');
    setBusy({ fraction: 0, label: 'Preparing video…' });
    try {
      const saved = await exportVideo(
        media,
        settings,
        lockedPalette ?? palette,
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
    if (!picking || busy || loading) return;
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
      const saved = await saveBytes(
        new TextEncoder().encode(JSON.stringify({ version: 1, settings }, null, 2)),
        'pixel-forge-preset.json',
        'json',
      );
      if (saved)
        setNotice(
          'Preset saved. Includes conversion settings only; source, trim, and anchors are not saved.',
        );
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const loadPreset = async (file: File) => {
    try {
      const input = JSON.parse(await file.text());
      if (input.version !== 1) throw Error('This is not a Pixel Forge preset.');
      const next = validateSettings(input.settings);
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
    if (
      !(await confirm({
        title: 'Install update and restart?',
        description: `${spriteDirty ? 'Your sprite project has unsaved changes. ' : ''}Restarting closes both workspaces, including the converter source, trim, and anchors. Cancel to save your work first.`,
        action: 'Install & restart',
      }))
    )
      return;
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
    if (videoMode)
      frameCount = media.animation
        ? animationTimeline(media.animation, start, end).length
        : frameTimes(start, end, fps).length;
  } catch {
    /* Validation displayed at export. */
  }
  const outputHeight = Math.max(1, Math.round((settings.width * media.height) / media.width));
  const displayOriginal = view === 'original' || picking !== null;

  const transferIssue =
    outputHeight > 512
      ? 'Reduce pixel width: editable frames and GIF/game-pack exports support up to 512 × 512 px.'
      : videoMode &&
          (!frameCount ||
            frameCount > 256 ||
            settings.width * outputHeight * frameCount > 16_000_000)
        ? 'Shorten the trim range or reduce FPS / pixel width. Editable frames and GIF/game-pack exports support 256 frames and 16 million total pixels.'
        : '';
  const createGameAsset = async () => {
    if (busy || loading) return;
    if (matchingFrames) {
      setPlaying(false);
      setWorkspace('sprites');
      return;
    }
    if (transferIssue) {
      setError(transferIssue);
      return;
    }
    setPlaying(false);
    if (
      spriteHasWork &&
      !(await confirm({
        title: 'Replace edited frames?',
        description: `Apply these adjustments to a new set of frames? This replaces “${spriteDoc.name}” and its undo history. ${spriteDirty ? 'It has unsaved changes. ' : ''}Cancel to keep your edits; you can resume them without replacing.`,
        action: 'Replace frames',
      }))
    )
      return;
    setError('');
    const controller = new AbortController();
    abortRef.current = controller;
    setJobKind('transfer');
    setBusy({ fraction: 0, label: 'Preparing editable frames…' });
    try {
      const document = videoMode
        ? await captureClip(
            media,
            settings,
            lockedPalette ?? palette,
            stabilization,
            start,
            end,
            fps,
            controller.signal,
            setBusy,
          )
        : documentFromCanvas(
            renderMedia(media, settings, lockedPalette, stabilization, time).canvas,
            media.name,
          );
      controller.signal.throwIfAborted();
      pipeline.current.link = { media, signature: sourceSignature, doc: document };
      setSpriteDoc(document);
      setSpriteOrigin('converter');
      setSpriteRevision((r) => r + 1);
      setSpriteHasWork(true);
      setSpriteDirty(true);
      setWorkspace('sprites');
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
      else setNotice('Preparation cancelled. Your frame edits are unchanged.');
    } finally {
      setBusy(null);
      abortRef.current = null;
    }
  };
  const automationVersion = useRef({
    value: crypto.randomUUID(),
    media,
    settings,
    start,
    end,
    fps,
    stabilization,
    time,
  });
  const previousVersion = automationVersion.current;
  if (
    previousVersion.media !== media ||
    previousVersion.settings !== settings ||
    previousVersion.start !== start ||
    previousVersion.end !== end ||
    previousVersion.fps !== fps ||
    previousVersion.stabilization !== stabilization ||
    previousVersion.time !== time
  )
    automationVersion.current = {
      value: crypto.randomUUID(),
      media,
      settings,
      start,
      end,
      fps,
      stabilization,
      time,
    };
  const converterState = () => ({
    revision: automationVersion.current.value,
    source: {
      name: media.name,
      kind: media.kind,
      width: media.width,
      height: media.height,
      duration: media.duration,
      timing: media.animation ? 'original' : 'sampled',
      sample,
    },
    settings,
    trim: { start, end },
    fps,
    time,
    stabilization,
    exportScale: scale,
    output: { width: settings.width, height: outputHeight, frames: videoMode ? frameCount : 1 },
    busy: !!busy || loading || playing || updateBusy || !!document.querySelector('dialog[open]'),
  });
  const assertConverterRevision = (expected: unknown) => {
    if (expected !== automationVersion.current.value)
      throw Error(
        'Converter changed. Read converter.get_state and retry with its current revision.',
      );
  };
  const assertAutomationReady = () => {
    if (busy || loading || playing || updateBusy || document.querySelector('dialog[open]'))
      throw Error('The editor is busy. Pause playback and close dialogs before making changes.');
  };
  useAutomationHandlers({
    'app.get_state': async (params) => {
      assertParams(params, []);
      return {
        version: APP_VERSION,
        workspace,
        converter: converterState(),
        sprite: await executeAutomationCommand('sprite.get_state', {}),
      };
    },
    'app.set_workspace': async (params, context) => {
      assertParams(params, ['workspace']);
      assertAutomationReady();
      if (!['converter', 'sprites'].includes(String(params.workspace)))
        throw Error('Workspace must be converter or sprites.');
      const sprite = (await executeAutomationCommand('sprite.get_state', {})) as { busy: boolean };
      if (sprite.busy) throw Error('The sprite editor is busy.');
      checkAutomationContext(context);
      flushSync(() => {
        if (params.workspace === 'converter') returnToAdjustments();
        else setWorkspace('sprites');
      });
      return { workspace: params.workspace };
    },
    'converter.get_state': (params) => {
      assertParams(params, []);
      return converterState();
    },
    'converter.preview': async (params, context) => {
      assertParams(params, []);
      const revision = automationVersion.current.value;
      const snapshot = renderMedia(media, settings, palette, stabilization, time).canvas;
      const bytes = await pngBytes(snapshot);
      checkAutomationContext(context);
      return {
        name: 'conversion.png',
        mimeType: 'image/png',
        base64: bytesToBase64(bytes),
        width: snapshot.width,
        height: snapshot.height,
        revision,
      };
    },
    'converter.configure': (params, context) => {
      assertParams(params, ['expectedRevision', 'settings', 'fps', 'trim']);
      assertAutomationReady();
      assertConverterRevision(params.expectedRevision);
      const next =
        params.settings === undefined ? settings : validateSettings(params.settings, settings);
      const nextFps = params.fps === undefined ? fps : integer(params.fps, 'FPS', 6, 60);
      if (media.animation && params.fps !== undefined && params.fps !== fps)
        throw Error(
          'This animation preserves original frame durations. Change timing with sprite.apply_edits.',
        );
      const trim =
        params.trim === undefined ? { start, end } : validateTrim(params.trim, media.duration);
      checkAutomationContext(context);
      flushSync(() => {
        setSettings(next);
        setFps(nextFps);
        setStart(trim.start);
        setEnd(trim.end);
        setNotice('AI connection updated conversion settings.');
      });
      return { revision: automationVersion.current.value };
    },
    'converter.import': async (params, context) => {
      assertParams(params, ['expectedRevision', 'replace', 'name', 'mimeType', 'base64']);
      assertAutomationReady();
      assertConverterRevision(params.expectedRevision);
      if (params.replace !== true)
        throw Error('Set replace:true to replace the converter source and reset trim and anchors.');
      if (typeof params.name !== 'string' || !params.name.trim() || params.name.length > 200)
        throw Error('Provide a source name up to 200 characters.');
      if (
        !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/webm', 'video/mp4'].includes(
          String(params.mimeType),
        )
      )
        throw Error('Use PNG, JPEG, WebP, GIF, WebM, or MP4.');
      const bytes = base64ToBytes(params.base64);
      setLoading(true);
      let loaded: Media | undefined;
      try {
        loaded = await loadMedia(
          new File([new Uint8Array(bytes)], params.name, { type: params.mimeType as string }),
          32_000_000,
        );
        checkAutomationContext(context);
        assertConverterRevision(params.expectedRevision);
        if (loaded.width * loaded.height > 32_000_000)
          throw Error('AI imports support source frames up to 32 megapixels.');
        const next = loaded;
        flushSync(() => {
          if (pipeline.current.original) disposeMedia(pipeline.current.original.media);
          pipeline.current.original = undefined;
          pipeline.current.link = undefined;
          setMedia(next);
          if (next.animation) {
            setSettings({ ...defaults, width: next.width, palette: 'original', dither: 'none' });
            setScale(1);
            setFormat('gif');
          }
          setSample(false);

          setTime(0);
          setStart(0);
          setEnd(next.duration);
          setStabilization(emptyStabilization);
          setView('pixel');
          setZoom(1);
          setNotice('AI connection opened a converter source.');
        });
        loaded = undefined;
        return { revision: automationVersion.current.value };
      } finally {
        if (loaded) disposeMedia(loaded);
        flushSync(() => setLoading(false));
      }
    },
    'converter.transfer': async (params, context) => {
      assertParams(params, ['expectedRevision', 'expectedSpriteRevision', 'replace']);
      assertAutomationReady();
      assertConverterRevision(params.expectedRevision);
      if (params.replace !== true)
        throw Error('Set replace:true to send a new copy to Game assets.');
      const target = (await executeAutomationCommand('sprite.get_state', {})) as {
        revision: string;
        busy: boolean;
      };
      if (target.revision !== params.expectedSpriteRevision || target.busy)
        throw Error('Game assets changed or is busy. Read sprite.get_state before transferring.');
      if (transferIssue) throw Error(transferIssue);
      setJobKind('transfer');
      setBusy({ fraction: 0, label: 'Preparing game asset for AI connection…' });
      try {
        const next = videoMode
          ? await captureClip(
              media,
              settings,
              lockedPalette ?? palette,
              stabilization,
              start,
              end,
              fps,
              context.signal,
              setBusy,
            )
          : documentFromCanvas(
              renderMedia(media, settings, palette, stabilization, time).canvas,
              media.name,
            );
        checkAutomationContext(context);
        assertConverterRevision(params.expectedRevision);
        const result = await executeAutomationCommand(
          'sprite.replace_internal',
          {
            document: next,
            expectedRevision: params.expectedSpriteRevision,
          },
          context,
        );
        pipeline.current.link = { media, signature: sourceSignature, doc: next };
        flushSync(() => setWorkspace('sprites'));
        return result;
      } finally {
        flushSync(() => setBusy(null));
      }
    },
  });
  return (
    <>
      <div hidden={workspace !== 'sprites'}>
        <SpriteStudio
          key={spriteRevision}
          initial={spriteDoc}
          visible={workspace === 'sprites'}
          origin={spriteOrigin}
          onDirtyChange={setSpriteDirty}
          onChange={(doc) => {
            setSpriteDoc(doc);
            setSpriteHasWork(true);
          }}
          onBack={returnToAdjustments}
          ffmpeg={ffmpeg}
          outputFormat={format === 'frames' ? 'pack' : format}
          onOutputFormatChange={setFormat}
          onOpenSettings={() => setShowSettings(true)}
          onOpenFile={chooseFile}
          openingFile={loading}
        />
      </div>
      <div
        hidden={workspace !== 'converter'}
        className="app"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (!busy && !loading && event.dataTransfer.files[0])
            void openFile(event.dataTransfer.files[0]);
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
          <div className="brand" aria-label="Pixel Forge">
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
          </div>
          <div className="header-divider" />
          <nav className="workspace-nav" aria-label="Workspaces">
            <button aria-current="page">Adjust media</button>
            <button
              aria-label="Edit frames"
              disabled={!!busy || loading}
              onClick={() => {
                setPlaying(false);
                setPicking(null);
                if (sample) setWorkspace('sprites');
                else void createGameAsset();
              }}
            >
              <Film size={15} /> Edit frames
              {spriteDirty && <span className="unsaved-dot" title="Unsaved sprite project" />}
            </button>
          </nav>
          <div className="topbar-right">
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
              onClick={chooseFile}
              title="Open an image, video, or GIF"
              disabled={!!busy || loading}
            >
              <FolderOpen size={15} /> Open file <kbd>{shortcut} O</kbd>
            </button>
          </div>
        </header>
        <div className="app-body">
          <main className="workspace">
            <div className="workspace-heading">
              <div>
                <h1>
                  {media.animation
                    ? media.animation.gifRepeat !== undefined
                      ? 'GIF adjustments'
                      : 'Frame adjustments'
                    : videoMode
                      ? 'Video editor'
                      : 'Image editor'}
                </h1>
                <p>
                  {media.width} × {media.height} source
                  {videoMode
                    ? ` · ${timeLabel(media.duration)} duration`
                    : ' · PNG, JPEG, WebP, SVG'}
                </p>
              </div>
            </div>
            <div className={`workflow-bar ${sample ? 'is-sample' : 'document-actions'}`}>
              <div>
                <b>
                  {sample
                    ? 'Open a file to start'
                    : `${videoMode ? `${frameCount} frames` : '1 frame'} · ${settings.width} × ${outputHeight} px`}
                </b>
                <p>
                  {sample
                    ? 'Open an image, GIF, or video. Adjust appearance, edit frames if needed, then choose an output.'
                    : media.animation
                      ? 'Original timing'
                      : videoMode
                        ? `${fps} FPS`
                        : 'Still image'}
                </p>
                {transferIssue && <p className="inline-warning">{transferIssue}</p>}
              </div>
              <div className="workflow-actions">
                {pipeline.current.original && (
                  <button
                    className="text-button"
                    disabled={!!busy || loading}
                    onClick={async () => {
                      if (
                        !matchingFrames &&
                        !(await confirm({
                          title: 'Return to original source?',
                          description:
                            'This restores the original media and its earlier adjustments. Adjustments made to the edited frames here will be discarded. Your pixel edits and frame timing are kept in Edit frames.',
                          action: 'Restore original',
                        }))
                      )
                        return;
                      const original = pipeline.current.original!;
                      pipeline.current.original = undefined;
                      restoreSource(original);
                    }}
                  >
                    Return to original source
                  </button>
                )}
                {spriteHasWork && !matchingFrames && (
                  <button
                    className="text-button"
                    disabled={!!busy || loading}
                    onClick={() => setWorkspace('sprites')}
                  >
                    Resume frame edits
                  </button>
                )}
                {!sample && (
                  <button
                    className="button subtle"
                    disabled={!!busy || loading}
                    onClick={() => {
                      setPlaying(false);
                      setSettings((s) => ({ ...s, alpha: 'key' }));
                      setPicking('color');
                      showProperties('background', 'alpha-section');
                    }}
                  >
                    <Pipette size={16} />
                    Remove background
                  </button>
                )}
                {sample && (
                  <button
                    className="button primary"
                    onClick={chooseFile}
                    disabled={!!busy || loading}
                    title="Open an image, video, or GIF"
                  >
                    <FolderOpen size={16} /> Open file
                  </button>
                )}
                <button
                  className="button subtle"
                  disabled={!!busy || loading || !!transferIssue}
                  onClick={() => void createGameAsset()}
                >
                  <Grid2X2 size={16} /> Edit pixels &amp; frames <ArrowRight size={14} />
                </button>
              </div>
            </div>
            <div className="editor">
              <div className="editor-toolbar">
                <div className="file-title">
                  {videoMode ? <Film size={15} /> : <ImageIcon size={15} />}
                  <span title={media.name}>{media.name}</span>
                  <span className="file-type">
                    {media.animation
                      ? media.animation.gifRepeat !== undefined
                        ? 'GIF'
                        : 'FRAMES'
                      : videoMode
                        ? 'VIDEO'
                        : 'IMAGE'}
                  </span>
                </div>
                <div className="preview-switch" aria-label="Preview mode">
                  <button
                    className={!displayOriginal ? 'selected' : ''}
                    aria-pressed={!displayOriginal}
                    onClick={() => {
                      setView('pixel');
                      setPicking(null);
                    }}
                  >
                    Result
                  </button>
                  <button
                    className={displayOriginal ? 'selected' : ''}
                    aria-pressed={displayOriginal}
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
                    tabIndex={0}
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
                    <kbd>Esc to cancel</kbd>
                    <button aria-label="Cancel picking" onClick={() => setPicking(null)}>
                      <X size={15} />
                    </button>
                  </div>
                )}
                {loading && (
                  <div className="loading-overlay" role="status">
                    <LoaderCircle className="spin" /> Opening media…
                  </div>
                )}
              </div>
              <div className="canvas-bottom">
                <div className="canvas-status">
                  <span className="status-dot" />
                  {displayOriginal
                    ? 'Original preview'
                    : `${settings.palette === 'original' ? 'Original colors' : `${palette.length} colors`} · ${settings.width} × ${outputHeight} pixels`}
                </div>
                <div className="canvas-view-controls">
                  <button
                    title={`Preview background: ${background}. Click to cycle checkerboard, dark, and light.`}
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
                  <button
                    className="icon-button"
                    aria-label="Fit canvas"
                    onClick={() => setZoom(1)}
                  >
                    <Maximize size={14} />
                  </button>
                </div>
              </div>
            </div>
            {videoMode ? (
              <div
                className={`timeline ${stabilization.enabled || stabilization.keyframes.length ? 'has-anchors' : ''}`}
              >
                <div className="timeline-heading">
                  <div className="transport">
                    <button
                      className="icon-button"
                      aria-label="Previous frame"
                      title="Previous frame (←)"
                      onClick={() => void stepFrame(-1)}
                      disabled={!!busy || loading}
                    >
                      <ArrowLeft size={15} />
                    </button>
                    <button
                      className="play-button"
                      aria-label={playing ? 'Pause video' : 'Play video'}
                      title="Play / pause (Space)"
                      onClick={() => {
                        if (time >= end - 0.05) void seek(start).then(() => setPlaying(true));
                        else setPlaying(!playing);
                      }}
                      disabled={!!busy || loading}
                    >
                      {playing ? <Pause size={17} /> : <Play size={17} />}
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Next frame"
                      title="Next frame (→)"
                      onClick={() => void stepFrame(1)}
                      disabled={!!busy || loading}
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
                      className="button small subtle"
                      onClick={() => showProperties('timing', 'clip-timing')}
                    >
                      Trim &amp; timing
                    </button>
                    <button
                      className={`button small ${picking === 'anchor' ? 'primary' : 'subtle'}`}
                      onClick={() => {
                        setPlaying(false);
                        setPicking('anchor');
                        showProperties('timing', 'anchor-settings');
                      }}
                      disabled={!!busy || loading}
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
                    step={media.animation ? 0.001 : 1 / fps}
                    value={time}
                    onChange={(e) => void seek(+e.target.value)}
                    disabled={!!busy || loading}
                  />
                  <div className="playhead" style={{ left: `${(time / media.duration) * 100}%` }} />
                </div>
                <p className="timeline-hint">
                  <MousePointer2 size={12} /> Space to play / pause · ← / → previous / next frame
                  {stabilization.enabled && ' · Anchors keep a feature stationary'}
                </p>
              </div>
            ) : null}
            <div className="workspace-footer">
              <span>
                <ShieldCheck size={13} /> Processed on your device
              </span>
              <span>
                v{APP_VERSION} · {desktop ? 'Desktop' : 'Browser preview'}
              </span>
              <button
                disabled={!!busy || loading}
                onClick={async () => {
                  if (
                    !sample &&
                    !(await confirm({
                      title: 'Load the sample image?',
                      description:
                        'This replaces the source media and resets its trim and stabilization markers. Your frame edits are kept.',
                      action: 'Load sample',
                    }))
                  )
                    return;
                  setPlaying(false);
                  setPicking(null);
                  setSample(true);
                  setMedia(demoMedia());

                  setTime(0);
                  setStart(0);
                  setEnd(0);
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
              <h2>Media properties</h2>
              <button
                className="icon-button"
                aria-label="Reset adjustments"
                title="Reset adjustments"
                disabled={!!busy || loading}
                onClick={() => {
                  setSettings(
                    sample
                      ? { ...defaults, palette: 'earth' }
                      : {
                          ...defaults,
                          width: Math.min(512, media.width),
                          palette: 'original',
                          dither: 'none',
                        },
                  );
                  setNotice(
                    sample
                      ? 'Sample adjustments reset.'
                      : 'Appearance and background reset. Trim and frame edits are kept.',
                  );
                }}
              >
                <RotateCcw size={15} />
              </button>
            </div>
            <nav className="inspector-tabs" aria-label="Media properties">
              {(
                [
                  ['appearance', 'Appearance'],
                  ['background', 'Background'],
                  ...(videoMode ? [['timing', 'Timing']] : []),
                  ['export', 'Export'],
                ] as const
              ).map(([panel, label]) => (
                <button
                  key={panel}
                  aria-pressed={activePropertyPanel === panel}
                  aria-controls={`media-${panel}`}
                  onClick={() => setPropertyPanel(panel as typeof propertyPanel)}
                >
                  {label}
                </button>
              ))}
            </nav>
            <div className="controls-scroll">
              <fieldset className="controls-fields" disabled={!!busy || loading}>
                <div
                  id="media-appearance"
                  className="inspector-tabpanel"
                  hidden={activePropertyPanel !== 'appearance'}
                >
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
                          aria-pressed={settings.width === n}
                          onClick={() => set('width', n)}
                        >
                          {n} px
                        </button>
                      ))}
                    </div>
                    <button
                      className="text-button"
                      disabled={media.width > 512 || settings.width === media.width}
                      title={
                        media.width > 512
                          ? 'The working pixel canvas supports widths up to 512 px.'
                          : 'Use the source pixel dimensions without resizing.'
                      }
                      onClick={() => set('width', media.width)}
                    >
                      Original size · {media.width} × {media.height}
                    </button>
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
                </div>
                <div
                  id="media-background"
                  className="inspector-tabpanel"
                  hidden={propertyPanel !== 'background'}
                >
                  <div className="panel-intro">
                    <h3>Remove a background</h3>
                    <p>
                      Pick a solid color in the preview, then refine its edges. The checkerboard
                      shows transparent pixels.
                    </p>
                    {settings.alpha !== 'key' && (
                      <button
                        className="button subtle full"
                        disabled={!!busy || loading}
                        onClick={() => {
                          setPlaying(false);
                          setSettings((s) => ({ ...s, alpha: 'key' }));
                          setPicking('color');
                          showProperties('background', 'alpha-section');
                        }}
                      >
                        <Pipette size={15} /> Pick color to remove
                      </button>
                    )}
                  </div>
                  <div id="alpha-section">
                    <Section title="Transparency & chroma key" icon={<Layers2 size={15} />}>
                      <label className="select-field">
                        <span>Background treatment</span>
                        <select
                          aria-label="Alpha mode"
                          value={settings.alpha}
                          onChange={(e) => set('alpha', e.target.value as Settings['alpha'])}
                        >
                          <option value="preserve">Keep existing transparency</option>
                          <option value="key">Remove a color · chroma key</option>
                          <option value="threshold">Hard edges · pixel art</option>
                          <option value="opaque">Solid background</option>
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
                              className={`button subtle small ${picking === 'color' ? 'is-on' : ''}`}
                              aria-pressed={picking === 'color'}
                              aria-label="Sample key color"
                              title="Sample from original"
                              onClick={() => {
                                setPlaying(false);
                                setPicking('color');
                              }}
                            >
                              <Pipette size={16} /> Sample
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
                      {videoMode && !media.animation && (
                        <p className="help-text">
                          Video alpha depends on the source codec and system decoder. Color key can
                          create alpha from a solid background.
                        </p>
                      )}
                    </Section>
                  </div>
                </div>
                {videoMode && (
                  <div
                    id="media-timing"
                    className="inspector-tabpanel"
                    hidden={propertyPanel !== 'timing'}
                  >
                    <div id="anchor-settings">
                      <Section
                        title="Anchor stabilization"
                        icon={<Crosshair size={15} />}
                        open={false}
                      >
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
                          stationary target. This moves video pixels; the sprite pivot is set
                          separately when editing frames.
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
                    </div>
                    <div id="clip-timing">
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
                          <span>{media.animation ? 'Frame timing' : 'Export frame rate'}</span>
                          <select
                            aria-label="Export frame rate"
                            value={media.animation ? 'original' : fps}
                            disabled={!!media.animation}
                            onChange={(e) => setFps(+e.target.value)}
                          >
                            {media.animation && (
                              <option value="original">Original frame durations</option>
                            )}
                            {![6, 8, 12, 15, 24, 30, 60].includes(fps) && (
                              <option value={fps}>{fps} FPS</option>
                            )}
                            {[6, 8, 12, 15, 24, 30, 60].map((n) => (
                              <option key={n} value={n}>
                                {n} FPS
                              </option>
                            ))}
                          </select>
                        </label>
                        <p className="help-text">
                          {media.animation
                            ? 'Original frame durations are preserved. Change individual timing in Edit frames.'
                            : 'Video is sampled at this frame rate. Exports are silent; GIF and game packs support up to 256 editable frames.'}
                        </p>
                      </Section>
                    </div>
                  </div>
                )}
                <div className="preset-row" hidden={activePropertyPanel !== 'appearance'}>
                  <button className="text-button" onClick={() => void savePreset()}>
                    <Save size={13} /> Save preset
                  </button>
                  <button className="text-button" onClick={() => presetRef.current?.click()}>
                    Load preset <ChevronRight size={12} />
                  </button>
                </div>
              </fieldset>
              <div
                id="media-export"
                className="export-options inspector-tabpanel"
                hidden={propertyPanel !== 'export'}
              >
                <div className="export-heading">
                  <span>EXPORT</span>
                  <span className="png-badge">{videoMode ? 'MOTION' : 'PNG'}</span>
                </div>
                {videoMode && (
                  <label className="select-field">
                    <span>Output format</span>
                    <select
                      aria-label="Video export format"
                      value={format}
                      onChange={(e) => setFormat(e.target.value as VideoFormat)}
                      disabled={!!busy || loading}
                    >
                      <option value="gif">Animated GIF (.gif)</option>
                      <option value="pack">Game asset pack (.zip)</option>
                      <option value="frames">RGBA PNG sequence (.zip)</option>
                      <option value="webm" disabled={!desktop}>
                        WebM · transparent video (.webm)
                      </option>
                      <option value="mov" disabled={!desktop}>
                        MOV · transparent video (.mov)
                      </option>
                    </select>
                  </label>
                )}
                {videoMode && !desktop && (
                  <p className="help-text">MOV and WebM export are available in the desktop app.</p>
                )}
                <label className="select-field">
                  <span>Export scale</span>
                  <select
                    aria-label="Export scale"
                    value={videoMode && ['gif', 'pack'].includes(format) ? 1 : scale}
                    onChange={(e) => setScale(+e.target.value)}
                    disabled={!!busy || loading || (videoMode && ['gif', 'pack'].includes(format))}
                  >
                    {[1, 2, 4, 8].map((n) => (
                      <option key={n} value={n}>
                        {n}× · {settings.width * n} × {outputHeight * n} px
                      </option>
                    ))}
                  </select>
                </label>
                <p className="export-description">
                  {videoMode
                    ? format === 'gif'
                      ? `Animated GIF · ${frameCount} frames · ${settings.width} × ${outputHeight} px at 1×. Uses trim and appearance settings; GIF transparency is on/off.`
                      : format === 'pack'
                        ? `ZIP · PNG sprite sheet + JSON + PNG frames at 1×. Includes timing, transparency and pivot. Edit frames for sheet settings.`
                        : format === 'frames'
                          ? `ZIP · ${frameCount} PNG frames + timing/settings JSON. Uses trim, ${media.animation ? 'original frame timing' : 'FPS'}, and scale.`
                          : `${format === 'webm' ? 'WebM with alpha' : 'MOV ProRes 4444'} · silent video. Uses trim, ${media.animation ? 'original frame timing' : 'FPS'}, and scale; requires FFmpeg.`
                    : `One PNG · ${settings.width * scale} × ${outputHeight * scale} px. Palette, adjustments, and alpha mode applied.`}
                </p>
                {(!videoMode || !['gif', 'pack'].includes(format)) && (
                  <>
                    <label className="toggle-label export-grid">
                      <input
                        type="checkbox"
                        checked={includeGrid && scale >= 4}
                        disabled={!!busy || loading || scale < 4}
                        onChange={(e) => setIncludeGrid(e.target.checked)}
                      />{' '}
                      Include grid in {videoMode ? 'single-frame PNG' : 'PNG'}
                    </label>
                    {scale < 4 && (
                      <p className="help-text">PNG grid is available at 4× or 8× scale.</p>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="export-panel export-dock">
              <button
                className="output-summary"
                onClick={() => setPropertyPanel('export')}
                aria-label="Show export settings"
              >
                <span>
                  <b>
                    {videoMode
                      ? {
                          gif: 'Animated GIF',
                          pack: 'Game asset pack',
                          frames: 'PNG sequence',
                          mov: 'MOV video',
                          webm: 'WebM video',
                        }[format]
                      : 'PNG image'}
                  </b>
                  <small>
                    {settings.width * (videoMode && ['gif', 'pack'].includes(format) ? 1 : scale)} ×{' '}
                    {outputHeight * (videoMode && ['gif', 'pack'].includes(format) ? 1 : scale)} px
                    {videoMode ? ` · ${frameCount} frames` : ''}
                  </small>
                </span>
                <Settings2 size={15} />
              </button>
              {busy ? (
                <div className="export-progress" role="status">
                  <div>
                    <LoaderCircle className="spin" size={14} />
                    <span>{busy.label}</span>
                  </div>
                  <progress
                    aria-label={jobKind === 'transfer' ? 'Transfer progress' : 'Export progress'}
                    max="1"
                    value={busy.fraction}
                  />
                  <button
                    className="text-button"
                    disabled={busy.encoding}
                    onClick={() => abortRef.current?.abort()}
                  >
                    {jobKind === 'transfer' ? 'Cancel transfer' : 'Cancel export'}
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
                    {videoMode
                      ? {
                          gif: 'Export GIF',
                          pack: 'Export game asset pack',
                          frames: 'Export PNG sequence',
                          mov: 'Export MOV',
                          webm: 'Export WebM',
                        }[format]
                      : 'Export image'}
                    <ArrowRight size={16} />
                  </button>
                  {videoMode ? (
                    <button
                      className="text-button export-frame"
                      onClick={() => void exportCurrent()}
                    >
                      Export this frame as PNG
                    </button>
                  ) : (
                    <p className="export-note">Export PNG: {shortcut} Shift E · grid is optional</p>
                  )}
                </>
              )}
            </div>
          </aside>
        </div>
      </div>
      {showSettings && (
        <Dialog title="App settings" onClose={() => setShowSettings(false)}>
          <div className="settings-modal">
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
            <AutomationPanel />
            <hr />
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
        </Dialog>
      )}
      {(error || (workspace === 'converter' && notice)) && (
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
      {confirmation}
    </>
  );
}
