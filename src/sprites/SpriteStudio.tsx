import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  ArrowDownToLine,
  Copy,
  Crosshair,
  Eraser,
  FolderOpen,
  Grid2X2,
  Layers2,
  LoaderCircle,
  Minus,
  Maximize,
  PaintBucket,
  Pencil,
  Pipette,
  Play,
  Pause,
  Plus,
  Redo2,
  Save,
  Settings2,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { PALETTES, hexRGB, rgbHex } from '../engine';
import { desktop, saveBytes } from '../platform';
import { planAtlas } from './atlas';
import {
  createDocument,
  deleteFrame,
  floodFill,
  frameAtTime,
  moveFrame,
  newId,
  pixelLine,
  playbackOrder,
  resizeCanvas,
  sampleSprite,
  sheetDefaults,
  validateDocument,
  type AnimationTag,
  type SpriteDocument,
} from './model';
import {
  decodeProject,
  encodeProject,
  buildAssetPack,
  exportAssetPack,
  frameCanvas,
  importPngFrames,
  importSheet,
  safeName,
} from './io';
import './sprites.css';
import { useConfirmation } from '../Dialogs';
import { decodeGif, encodeGif } from './gif';
import { pngBytes } from '../media';
import {
  useAutomationHandlers,
  checkAutomationContext,
  type AutomationContext,
} from '../automation/bridge';
import { assertParams, base64ToBytes, bytesToBase64, integer, textValue } from '../automation/data';
import { applySpriteOperations } from '../automation/spriteEdits';
import FrameConversionDialog from './FrameConversionDialog';
import { exportSpriteVideo } from './videoExport';

type Tool = 'pencil' | 'eraser' | 'fill' | 'sample' | 'pivot';
function Thumbnail({
  pixels,
  width,
  height,
}: {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    ref.current
      ?.getContext('2d')!
      .putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  }, [pixels, width, height]);
  return <canvas ref={ref} width={width} height={height} />;
}
type InspectorPane = 'tools' | 'animation' | 'export';
function revealInspector(pane: InspectorPane) {
  flushSync(() => document.getElementById(`sprite-inspector-${pane}`)?.click());
}
function FrameInspector({
  tools,
  animation,
  exportSettings,
  footer,
}: {
  tools: ReactNode;
  animation: ReactNode;
  exportSettings: ReactNode;
  footer: ReactNode;
}) {
  const [pane, setPane] = useState<InspectorPane>('tools');
  return (
    <aside className="sprite-inspector">
      <nav
        className="inspector-tabs"
        aria-label="Frame properties"
        onKeyDown={(event) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
            event.stopPropagation();
        }}
      >
        {(['tools', 'animation', 'export'] as const).map((id) => (
          <button
            key={id}
            id={`sprite-inspector-${id}`}
            type="button"
            aria-pressed={pane === id}
            aria-controls={`sprite-panel-${id}`}
            onClick={() => setPane(id)}
          >
            {id === 'tools' ? 'Tools' : id === 'animation' ? 'Animation' : 'Export'}
          </button>
        ))}
      </nav>
      <div className="sprite-inspector-scroll">
        <div className="inspector-tabpanel" id="sprite-panel-tools" hidden={pane !== 'tools'}>
          {tools}
        </div>
        <div
          className="inspector-tabpanel"
          id="sprite-panel-animation"
          hidden={pane !== 'animation'}
        >
          {animation}
        </div>
        <div className="inspector-tabpanel" id="sprite-panel-export" hidden={pane !== 'export'}>
          {exportSettings}
        </div>
      </div>
      {footer}
    </aside>
  );
}
export default function SpriteStudio({
  initial,
  onBack,
  onOpenFile,
  openingFile,
  onChange,
  visible,
  origin,
  onDirtyChange,
  ffmpeg,
  onOpenSettings,
  outputFormat,
  onOutputFormatChange,
}: {
  initial: SpriteDocument;
  visible: boolean;
  origin: 'sample' | 'converter' | 'gif';
  onDirtyChange: (dirty: boolean) => void;
  onBack: () => void;
  onOpenFile: () => void;
  openingFile: boolean;
  ffmpeg: string;
  onOpenSettings: () => void;
  outputFormat?: 'gif' | 'pack' | 'mov' | 'webm';
  onOutputFormatChange?: (format: 'gif' | 'pack' | 'mov' | 'webm') => void;
  onChange: (doc: SpriteDocument) => void;
}) {
  const { confirm, confirmation } = useConfirmation();
  const [savedDoc, setSavedDoc] = useState<SpriteDocument | null>(
    origin === 'sample' ? initial : null,
  );
  const [isSample, setIsSample] = useState(origin === 'sample');
  const [showFrameConversion, setShowFrameConversion] = useState<false | 'convert' | 'key'>(false);
  const [hoverPixel, setHoverPixel] = useState<{ x: number; y: number } | null>(null);
  const [doc, setDoc] = useState(initial),
    [active, setActive] = useState(0);
  // Keep useState initializers stable during development so a UI refresh preserves live edits.
  const automationRevision = useRef({
    document: doc,
    value: newId(),
    initializeView: true,
    videoJob: null as { controller: AbortController; encoding: boolean } | null,
  });
  if (automationRevision.current.document !== doc)
    automationRevision.current = {
      ...automationRevision.current,
      document: doc,
      value: newId(),
      initializeView: false,
    };
  const automationBusy = useRef(false);
  const [past, setPast] = useState<SpriteDocument[]>([]),
    [future, setFuture] = useState<SpriteDocument[]>([]);
  const [tool, setTool] = useState<Tool>('pencil'),
    [color, setColor] = useState('#c7ec95');
  const [zoom, setZoom] = useState(initial.width > 64 ? 4 : 10),
    [grid, setGrid] = useState(true),
    [onion, setOnion] = useState(false),
    [showPivot, setShowPivot] = useState(true);
  const [playing, setPlaying] = useState(false),
    [loop, setLoop] = useState(initial.gifRepeat !== -1),
    [playTag, setPlayTag] = useState('');
  const [assetFormat, setAssetFormat] = useState<'pack' | 'gif' | 'mov' | 'webm'>('pack');
  const [workingLabel, setWorkingLabel] = useState('Preparing files…');
  const [options, setOptions] = useState(sheetDefaults),
    [message, setMessage] = useState(
      origin === 'gif'
        ? `GIF opened as ${initial.frames.length} editable frames with original timing. Frames without a delay use 100 ms.`
        : origin === 'converter'
          ? 'Conversion copied at 1× pixel size. Edit here; your converter source and settings are kept.'
          : '',
    ),
    [error, setError] = useState(''),
    [working, setWorking] = useState(false);
  const [tagName, setTagName] = useState('walk'),
    [tagFrom, setTagFrom] = useState(1),
    [tagTo, setTagTo] = useState(doc.frames.length),
    [tagDirection, setTagDirection] = useState<AnimationTag['direction']>('forward');
  const [canvasWidth, setCanvasWidth] = useState(doc.width),
    [canvasHeight, setCanvasHeight] = useState(doc.height),
    [allFps, setAllFps] = useState(12);
  const [importMode, setImportMode] = useState<'frames' | 'sheet' | 'gif'>('frames'),
    [cellW, setCellW] = useState(32),
    [cellH, setCellH] = useState(32),
    [cellGap, setCellGap] = useState(0),
    [cellMargin, setCellMargin] = useState(0),
    [cellCount, setCellCount] = useState(6);
  const viewportRef = useRef<HTMLDivElement>(null);
  const frameStripRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null),
    filesRef = useRef<HTMLInputElement>(null),
    projectRef = useRef<HTMLInputElement>(null);
  const stroke = useRef<{
    pixels: Uint8ClampedArray;
    last: { x: number; y: number };
    frame: number;
  } | null>(null);
  const dirty = doc !== savedDoc;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => {
    if (!visible) setPlaying(false);
  }, [visible]);
  useEffect(() => {
    setCanvasWidth(doc.width);
    setCanvasHeight(doc.height);
  }, [doc.width, doc.height]);
  useEffect(() => {
    if (!message) return;
    const timeout = setTimeout(() => setMessage(''), 6500);
    return () => clearTimeout(timeout);
  }, [message]);
  useEffect(() => {
    const strip = frameStripRef.current;
    const frame = strip?.children[active] as HTMLElement | undefined;
    if (!strip || !frame || !visible) return;
    const left = frame.offsetLeft;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (left + frame.offsetWidth > strip.scrollLeft + strip.clientWidth)
      strip.scrollLeft = left + frame.offsetWidth - strip.clientWidth;
  }, [active, visible]);
  const fitted = useRef(false);
  const fitDocument = (next: SpriteDocument) => {
    const viewport = viewportRef.current;
    if (!visible || !viewport || !viewport.clientWidth || !viewport.clientHeight) {
      // A hidden workspace has no usable layout. Fit its new document when shown.
      fitted.current = false;
      return;
    }
    const available = Math.min(
      Math.max(1, viewport.clientWidth - 64) / next.width,
      Math.max(1, viewport.clientHeight - 64) / next.height,
    );
    // Reciprocal steps fit large documents without changing their pixel data.
    setZoom(available < 1 ? 1 / Math.ceil(1 / available) : Math.min(24, Math.floor(available)));
    fitted.current = true;
  };
  const resetDocumentView = (next: SpriteDocument, chooseDefaultOutput = true) => {
    const isGif = next.gifRepeat !== undefined;
    const nextFormat = chooseDefaultOutput
      ? isGif
        ? 'gif'
        : 'pack'
      : (outputFormat ?? assetFormat);
    setAssetFormat(nextFormat);
    if (chooseDefaultOutput) onOutputFormatChange?.(nextFormat);
    setGrid(!isGif);
    setShowPivot(!isGif);
    fitDocument(next);
  };
  const fitCanvas = () => fitDocument(doc);
  const revealPivotSettings = () => {
    revealInspector('tools');
    setShowPivot(true);
    const details = document.getElementById('sprite-pivot-settings');
    if (details instanceof HTMLDetailsElement) details.open = true;
  };
  useEffect(() => {
    if (automationRevision.current.initializeView) {
      automationRevision.current.initializeView = false;
      if (initial.gifRepeat !== undefined || origin === 'gif') {
        setAssetFormat(outputFormat ?? 'gif');
        setGrid(false);
        setShowPivot(false);
      }
    }
    if (visible && outputFormat && outputFormat !== assetFormat) setAssetFormat(outputFormat);
    if (visible && !fitted.current) fitDocument(doc);
  }, [visible, outputFormat]);
  const current = doc.frames[Math.min(active, doc.frames.length - 1)];
  const order = useMemo(
    () =>
      playbackOrder(
        doc.tags.find((tag) => tag.name === playTag),
        doc.frames.length,
      ),
    [doc, playTag],
  );
  const totalDuration = order.reduce((sum, i) => sum + doc.frames[i].duration, 0);
  const commit = (next: SpriteDocument) => {
    try {
      validateDocument(next);
      setPast((p) => [...p.slice(-29), doc]);
      setFuture([]);
      setDoc(next);
      onChange(next);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const replace = async (next: SpriteDocument, saved = false) => {
    validateDocument(next);
    if (
      (!isSample || dirty) &&
      !(await confirm({
        title: 'Replace sprite project?',
        description: `This replaces “${doc.name}” with “${next.name}”. ${dirty ? 'Your changes have not been saved. ' : ''}Cancel to save a project first. You can also undo this replacement in this session.`,
        action: 'Replace project',
      }))
    )
      return false;
    setPlaying(false);
    commit(next);
    setActive(0);
    setPlayTag('');
    setLoop(next.gifRepeat !== -1);
    setCanvasWidth(next.width);
    setCanvasHeight(next.height);
    resetDocumentView(next);
    setTagTo(next.frames.length);
    setIsSample(false);
    if (saved) setSavedDoc(next);
    return true;
  };
  const undo = () => {
    if (!past.length) return;
    const previous = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    setFuture((p) => [doc, ...p]);
    setDoc(previous);
    onChange(previous);
    setActive((i) => Math.min(i, previous.frames.length - 1));
  };
  const redo = () => {
    if (!future.length) return;
    const next = future[0];
    setFuture((p) => p.slice(1));
    setPast((p) => [...p, doc]);
    setDoc(next);
    onChange(next);
    setActive((i) => Math.min(i, next.frames.length - 1));
  };
  const automationIdle = () => {
    if (
      working ||
      openingFile ||
      automationBusy.current ||
      playing ||
      stroke.current ||
      document.querySelector('dialog[open]')
    )
      throw Error(
        'The sprite editor is busy. Finish painting, stop playback, and close dialogs before editing or exporting.',
      );
  };
  const expectRevision = (value: unknown) => {
    if (typeof value !== 'string' || value !== automationRevision.current.value)
      throw Error('The sprite changed. Read sprite.get_state and retry with its current revision.');
  };
  const automationCommit = (next: SpriteDocument, context: AutomationContext) => {
    checkAutomationContext(context);
    validateDocument(next);
    flushSync(() => {
      commit(next);
      setActive((index) => Math.min(index, next.frames.length - 1));
      setIsSample(false);
      setMessage('API edit applied. Undo is available.');
    });
    return { revision: automationRevision.current.value };
  };
  useAutomationHandlers({
    'sprite.get_state': (params) => {
      assertParams(params, []);
      return {
        revision: automationRevision.current.value,
        name: doc.name,
        width: doc.width,
        height: doc.height,
        frames: doc.frames.map((frame, index) => ({ index, duration: frame.duration })),
        tags: doc.tags,
        pivot: doc.pivot,
        gifRepeat: doc.gifRepeat ?? 0,
        activeFrame: active,
        dirty,
        busy:
          working ||
          openingFile ||
          automationBusy.current ||
          playing ||
          !!stroke.current ||
          !!document.querySelector('dialog[open]'),
        canUndo: past.length > 0,
        canRedo: future.length > 0,
      };
    },
    'sprite.get_frame': async (params, context) => {
      assertParams(params, ['frame']);
      const index =
        params.frame === undefined
          ? active
          : integer(params.frame, 'Frame index', 0, doc.frames.length - 1);
      const revision = automationRevision.current.value;
      const bytes = await pngBytes(frameCanvas(doc.frames[index].pixels, doc.width, doc.height));
      checkAutomationContext(context);
      return {
        name: `${safeName(doc.name)}-${index}.png`,
        mimeType: 'image/png',
        base64: bytesToBase64(bytes),
        width: doc.width,
        height: doc.height,
        frame: index,
        revision,
      };
    },
    'sprite.apply': (params, context) => {
      assertParams(params, ['expectedRevision', 'operations']);
      automationIdle();
      expectRevision(params.expectedRevision);
      return automationCommit(applySpriteOperations(doc, params.operations), context);
    },
    'sprite.undo': (params, context) => {
      assertParams(params, ['expectedRevision']);
      automationIdle();
      expectRevision(params.expectedRevision);
      checkAutomationContext(context);
      if (!past.length) throw Error('There is no sprite edit to undo.');
      flushSync(() => {
        undo();
        setMessage('API edit undone.');
      });
      return { revision: automationRevision.current.value };
    },
    'sprite.redo': (params, context) => {
      assertParams(params, ['expectedRevision']);
      automationIdle();
      expectRevision(params.expectedRevision);
      checkAutomationContext(context);
      if (!future.length) throw Error('There is no sprite edit to redo.');
      flushSync(() => {
        redo();
        setMessage('API edit restored.');
      });
      return { revision: automationRevision.current.value };
    },
    'sprite.replace_internal': (params, context) => {
      assertParams(params, ['document', 'expectedRevision']);
      automationIdle();
      expectRevision(params.expectedRevision);
      const next = params.document as SpriteDocument;
      validateDocument(next);
      const result = automationCommit(next, context);
      flushSync(() => {
        setActive(0);
        setPlayTag('');
        setLoop(next.gifRepeat !== -1);
        setTagTo(next.frames.length);
        resetDocumentView(next, false);
      });
      return result;
    },
    'sprite.import': (params, context) => {
      assertParams(params, ['format', 'base64', 'name', 'expectedRevision', 'replace']);
      automationIdle();
      expectRevision(params.expectedRevision);
      if (params.replace !== true)
        throw Error(
          'Set replace:true to explicitly replace the sprite. Replacement can be undone.',
        );
      const name = textValue(params.name, 'Import name', 200);
      if (params.format !== 'project' && params.format !== 'gif')
        throw Error('Choose project or gif import.');
      const bytes = base64ToBytes(params.base64);
      const next = params.format === 'gif' ? decodeGif(bytes, name) : decodeProject(bytes);
      expectRevision(params.expectedRevision);
      const result = automationCommit(next, context);
      flushSync(() => {
        setActive(0);
        setPlayTag('');
        setLoop(next.gifRepeat !== -1);
        setTagTo(next.frames.length);
        resetDocumentView(next);
      });
      return result;
    },
    'sprite.export': async (params, context) => {
      assertParams(params, ['format']);
      if (!['project', 'pack', 'gif'].includes(String(params.format)))
        throw Error('Choose project, pack or gif export.');
      automationIdle();
      const revision = automationRevision.current.value;
      automationBusy.current = true;
      flushSync(() => {
        setWorking(true);
        setWorkingLabel('Preparing API export…');
      });
      try {
        const bytes =
          params.format === 'project'
            ? encodeProject(doc)
            : params.format === 'pack'
              ? await buildAssetPack(doc, options)
              : await encodeGif(doc, order, setWorkingLabel);
        checkAutomationContext(context);
        const extension =
          params.format === 'project' ? 'pixelforge' : params.format === 'pack' ? 'zip' : 'gif';
        return {
          name: `${safeName(doc.name)}.${extension}`,
          mimeType: params.format === 'gif' ? 'image/gif' : 'application/zip',
          base64: bytesToBase64(bytes),
          revision,
        };
      } finally {
        automationBusy.current = false;
        flushSync(() => setWorking(false));
      }
    },
  });
  const draw = (pixels = current.pixels) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, doc.width, doc.height);
    ctx.imageSmoothingEnabled = false;
    if (onion && !playing) {
      if (active > 0) {
        ctx.globalAlpha = 0.25;
        ctx.drawImage(frameCanvas(doc.frames[active - 1].pixels, doc.width, doc.height), 0, 0);
      }
      if (active < doc.frames.length - 1) {
        ctx.globalAlpha = 0.15;
        ctx.drawImage(frameCanvas(doc.frames[active + 1].pixels, doc.width, doc.height), 0, 0);
      }
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(frameCanvas(pixels, doc.width, doc.height), 0, 0);
  };
  useEffect(() => {
    draw();
  }, [doc, active, onion, playing]);
  useEffect(() => {
    if (!playing || !visible) return;
    let raf = 0;
    const selectedIndex = Math.max(0, order.indexOf(active));
    const offset = order
      .slice(0, selectedIndex)
      .reduce((sum, index) => sum + doc.frames[index].duration, 0);
    const start = performance.now() - offset;
    const tick = (now: number) => {
      const elapsed = now - start;
      if (!loop && elapsed >= totalDuration) {
        setActive(order[order.length - 1]);
        setPlaying(false);
        return;
      }
      setActive(frameAtTime(doc, order, elapsed));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, loop, doc, order, totalDuration, visible]);
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (working || openingFile || document.querySelector('dialog[open]')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        setPlaying(false);
        onOpenFile();
        return;
      }
      if (
        e.target instanceof HTMLElement &&
        (e.target.closest('input, select, textarea, [contenteditable]') ||
          (e.code === 'Space' && e.target.closest('button, summary')))
      )
        return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (!playing) {
          if (e.shiftKey) redo();
          else undo();
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        if (!playing) redo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((p) => !p);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setPlaying(false);
        const next = Math.max(0, active - 1);
        setActive(next);
        if (e.target instanceof HTMLElement && e.target.closest('.sprite-frame'))
          (frameStripRef.current?.children[next] as HTMLElement | undefined)?.focus();
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setPlaying(false);
        const next = Math.min(doc.frames.length - 1, active + 1);
        setActive(next);
        if (e.target instanceof HTMLElement && e.target.closest('.sprite-frame'))
          (frameStripRef.current?.children[next] as HTMLElement | undefined)?.focus();
      }
      const tools: Record<string, Tool> = {
        b: 'pencil',
        e: 'eraser',
        g: 'fill',
        i: 'sample',
        p: 'pivot',
      };
      if (tools[e.key.toLowerCase()] && !playing) {
        setTool(tools[e.key.toLowerCase()]);
        if (tools[e.key.toLowerCase()] === 'pivot') revealPivotSettings();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(doc.width - 1, Math.floor(((e.clientX - r.left) * doc.width) / r.width)),
      ),
      y: Math.max(
        0,
        Math.min(doc.height - 1, Math.floor(((e.clientY - r.top) * doc.height) / r.height)),
      ),
    };
  };
  const paint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!stroke.current) return;
    const p = point(e),
      rgba = tool === 'eraser' ? [0, 0, 0, 0] : [...hexRGB(color), 255];
    for (const q of pixelLine(stroke.current.last.x, stroke.current.last.y, p.x, p.y))
      stroke.current.pixels.set(rgba, (q.y * doc.width + q.x) * 4);
    stroke.current.last = p;
    draw(stroke.current.pixels);
  };
  const pointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (playing || working || openingFile || e.button !== 0) return;
    e.preventDefault();
    const p = point(e),
      i = (p.y * doc.width + p.x) * 4;
    if (tool === 'sample') {
      if (current.pixels[i + 3] === 0) {
        setMessage('This pixel is transparent. Choose a visible pixel to sample.');
        return;
      }
      const sampled = rgbHex([current.pixels[i], current.pixels[i + 1], current.pixels[i + 2]]);
      setColor(sampled);
      setMessage(`Sampled ${sampled.toUpperCase()}. Pencil selected.`);
      setTool('pencil');
      return;
    }
    if (tool === 'pivot') {
      commit({ ...doc, pivot: p });
      setMessage(`Shared pivot set to ${p.x}, ${p.y} px. Pixels stay in place.`);
      return;
    }
    const pixels = current.pixels.slice();
    if (tool === 'fill') {
      floodFill(pixels, doc.width, p.x, p.y, [...hexRGB(color), 255]);
      commit({ ...doc, frames: doc.frames.map((f, n) => (n === active ? { ...f, pixels } : f)) });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    stroke.current = { pixels, last: p, frame: active };
    paint(e);
  };
  const finishStroke = () => {
    if (!stroke.current) return;
    const s = stroke.current;
    stroke.current = null;
    commit({
      ...doc,
      frames: doc.frames.map((f, n) => (n === s.frame ? { ...f, pixels: s.pixels } : f)),
    });
  };
  const addFrame = (duplicate: boolean) => {
    const frames = [...doc.frames],
      index = active + 1;
    frames.splice(index, 0, {
      id: newId(),
      duration: current.duration,
      pixels: duplicate
        ? current.pixels.slice()
        : new Uint8ClampedArray(doc.width * doc.height * 4),
    });
    const next = {
      ...doc,
      frames,
      tags: doc.tags.map((t) => ({
        ...t,
        from: t.from > active ? t.from + 1 : t.from,
        to: t.to >= active ? t.to + 1 : t.to,
      })),
    };
    try {
      validateDocument(next);
      commit(next);
      setActive(index);
      setTagTo(frames.length);
    } catch (e) {
      setError(String(e));
    }
  };
  const updateDuration = (duration: number) => {
    if (Number.isInteger(duration) && duration >= 10 && duration <= 60000)
      commit({ ...doc, frames: doc.frames.map((f, i) => (i === active ? { ...f, duration } : f)) });
  };
  const run = async (task: () => Promise<void>) => {
    setWorking(true);
    setWorkingLabel('Preparing files…');
    setPlaying(false);
    setError('');
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };
  const { atlasInfo, atlasError } = useMemo(() => {
    try {
      const plan = planAtlas(doc, options);
      return {
        atlasInfo: `${plan.width} × ${plan.height} px · ${plan.columns} columns · ${plan.rows} rows`,
        atlasError: '',
      };
    } catch (error) {
      return { atlasInfo: '', atlasError: error instanceof Error ? error.message : String(error) };
    }
  }, [doc, options]);
  const colors = useMemo(() => {
    const values = new Set<string>();
    for (const frame of doc.frames) {
      for (let i = 0; i < frame.pixels.length; i += 4)
        if (frame.pixels[i + 3]) {
          values.add(rgbHex([frame.pixels[i], frame.pixels[i + 1], frame.pixels[i + 2]]));
          if (values.size >= 24) break;
        }
      if (values.size >= 24) break;
    }
    return [...values, ...PALETTES.pico8.colors.filter((c) => !values.has(c))].slice(0, 32);
  }, [doc]);
  return (
    <div className="sprite-shell">
      {showFrameConversion && (
        <FrameConversionDialog
          doc={doc}
          mode={showFrameConversion === 'key' ? 'key' : 'convert'}
          onClose={() => setShowFrameConversion(false)}
          onApply={(next) => {
            commit(next);
            fitDocument(next);
            setShowFrameConversion(false);
            setMessage(
              showFrameConversion === 'key'
                ? 'Chroma key applied to every frame. Pixel size, timing, and pivot retained.'
                : 'Frames converted. Timing, tags, and pivot alignment retained.',
            );
          }}
        />
      )}
      <input
        className="hidden"
        ref={filesRef}
        aria-label="Import sprite frames"
        type="file"
        multiple={importMode === 'frames'}
        accept={importMode === 'gif' ? 'image/gif' : 'image/png,image/webp'}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length)
            void run(async () => {
              const replaced = await replace(
                importMode === 'gif'
                  ? decodeGif(new Uint8Array(await files[0].arrayBuffer()), files[0].name)
                  : importMode === 'frames'
                    ? await importPngFrames(files, Math.round(1000 / allFps))
                    : await importSheet(
                        files[0],
                        cellW,
                        cellH,
                        cellGap,
                        cellMargin,
                        cellCount,
                        Math.round(1000 / allFps),
                      ),
              );
              if (replaced)
                setMessage(
                  importMode === 'gif'
                    ? 'GIF frames imported with original timing. Frames without a delay use 100 ms.'
                    : 'Frames imported at their original pixel resolution.',
                );
            });
          e.target.value = '';
        }}
      />
      <input
        className="hidden"
        ref={projectRef}
        aria-label="Open sprite project"
        type="file"
        accept=".pixelforge"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file)
            void run(async () => {
              if (await replace(decodeProject(new Uint8Array(await file.arrayBuffer())), true))
                setMessage('Sprite project opened.');
            });
          e.target.value = '';
        }}
      />
      <header className="topbar">
        <div className="brand" aria-label="Pixel Forge">
          <span className="brand-mark" aria-hidden="true">
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
          <button
            onClick={onBack}
            disabled={working || openingFile}
            title="Return to source adjustments. Frame edits and undo history stay here."
          >
            Adjust media
          </button>
          <button aria-current="page">
            <Layers2 size={15} /> Edit frames
          </button>
        </nav>
        <div className="topbar-right">
          <button
            className="button subtle small"
            disabled={working || openingFile}
            title="Open an image, video, or GIF (Ctrl/⌘ O)."
            onClick={() => {
              setPlaying(false);
              onOpenFile();
            }}
          >
            <FolderOpen size={14} /> Open file
          </button>
          <button
            className="button subtle small"
            onClick={() => projectRef.current?.click()}
            disabled={working || openingFile}
          >
            <FolderOpen size={14} /> Open project
          </button>
          <button
            className="button subtle small"
            disabled={working || openingFile}
            onClick={() =>
              void run(async () => {
                if (
                  await saveBytes(
                    encodeProject(doc),
                    `${safeName(doc.name)}.pixelforge`,
                    'pixelforge',
                  )
                ) {
                  setSavedDoc(doc);
                  setMessage('Editable sprite project saved.');
                }
              })
            }
          >
            <Save size={14} /> Save project
          </button>
          <button
            className="icon-button"
            aria-label="App settings"
            title="App settings"
            disabled={working || openingFile}
            onClick={() => {
              setPlaying(false);
              onOpenSettings();
            }}
          >
            <Settings2 size={17} />
          </button>
        </div>
      </header>
      <div className="sprite-body">
        <main className="sprite-main">
          <div className="sprite-heading">
            <div>
              <div className="sprite-document-line">
                <h1>Frame editor</h1>
                <span className="document-state">
                  {isSample ? 'Sample animation' : dirty ? 'Unsaved changes' : 'Project saved'}
                </span>
              </div>
              <p>
                {doc.width} × {doc.height} pixels · {doc.frames.length} frames ·{' '}
                {doc.frames.reduce((sum, frame) => sum + frame.duration, 0)} ms
              </p>
            </div>
            <label className="sprite-name">
              Name
              <input
                disabled={playing || working || openingFile}
                aria-label="Asset name"
                value={doc.name}
                maxLength={100}
                onChange={(e) => commit({ ...doc, name: e.target.value })}
              />
            </label>
          </div>

          <div className="sprite-editor">
            <div className="sprite-toolbar">
              <div className="sprite-tools">
                {(
                  [
                    ['pencil', Pencil, 'Pencil (B)'],
                    ['eraser', Eraser, 'Eraser (E)'],
                    ['fill', PaintBucket, 'Fill (G)'],
                    ['sample', Pipette, 'Sample color (I)'],
                    ['pivot', Crosshair, 'Set pivot (P)'],
                  ] as const
                ).map(([id, Icon, label]) => (
                  <button
                    key={id}
                    className={`sprite-tool ${tool === id ? 'is-on' : ''}`}
                    title={label}
                    aria-label={label}
                    aria-pressed={tool === id}
                    disabled={playing || working || openingFile}
                    onClick={() => {
                      setTool(id);
                      if (id === 'pivot') revealPivotSettings();
                    }}
                  >
                    <Icon size={17} />
                    <span>{label.replace(/ \(.*\)/, '')}</span>
                  </button>
                ))}
                <span className="thin-divider" />
                <input
                  aria-label="Drawing color"
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                />
              </div>
              <div className="sprite-tools">
                <button
                  className="icon-button"
                  aria-label="Undo sprite edit"
                  title="Undo (Ctrl/⌘ Z)"
                  disabled={!past.length || playing || working || openingFile}
                  onClick={undo}
                >
                  <Undo2 size={17} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Redo sprite edit"
                  title="Redo (Ctrl/⌘ Shift Z)"
                  disabled={!future.length || playing || working || openingFile}
                  onClick={redo}
                >
                  <Redo2 size={17} />
                </button>
                <span className="thin-divider" />
                <button
                  className={`icon-button ${onion ? 'is-on' : ''}`}
                  aria-label="Toggle onion skin"
                  title="Onion skins: preview neighboring frames"
                  aria-pressed={onion}
                  onClick={() => setOnion(!onion)}
                >
                  <Layers2 size={17} />
                </button>
                <button
                  className={`icon-button ${grid ? 'is-on' : ''}`}
                  aria-label="Toggle sprite grid"
                  title="Pixel grid (preview only)"
                  aria-pressed={grid}
                  onClick={() => setGrid(!grid)}
                >
                  <Grid2X2 size={17} />
                </button>
                <button
                  className={`icon-button ${showPivot ? 'is-on' : ''}`}
                  aria-label="Toggle pivot guide"
                  title="Shared pivot guide (preview only)"
                  aria-pressed={showPivot}
                  onClick={() => setShowPivot(!showPivot)}
                >
                  <Crosshair size={17} />
                </button>
              </div>
            </div>
            <div className="tool-guidance" role="status">
              {playing
                ? 'Playing animation · pause to edit pixels and timing'
                : {
                    pencil: 'Pencil · drag to paint one pixel at a time',
                    eraser: 'Eraser · drag to make pixels transparent',
                    fill: 'Fill · click to replace a connected area of one color',
                    sample: 'Sample color · click a visible pixel to use its color',
                    pivot: 'Set pivot · click to place the shared game origin; pixels do not move',
                  }[tool]}
            </div>
            <div className="sprite-viewport" ref={viewportRef}>
              <div
                className="sprite-canvas-wrap"
                style={{ width: doc.width * zoom, height: doc.height * zoom }}
              >
                <canvas
                  ref={canvasRef}
                  aria-label="Sprite drawing canvas"
                  tabIndex={0}
                  width={doc.width}
                  height={doc.height}
                  onPointerDown={pointerDown}
                  onPointerMove={(e) => {
                    const pixel = point(e);
                    setHoverPixel((previous) =>
                      previous?.x === pixel.x && previous?.y === pixel.y ? previous : pixel,
                    );
                    paint(e);
                  }}
                  onPointerLeave={() => setHoverPixel(null)}
                  onPointerUp={finishStroke}
                  onPointerCancel={finishStroke}
                />
                {grid && zoom >= 4 && (
                  <div
                    className="sprite-pixel-grid"
                    style={{ backgroundSize: `${zoom}px ${zoom}px` }}
                  />
                )}
                {showPivot && (
                  <div
                    className="sprite-pivot"
                    style={{ left: doc.pivot.x * zoom, top: doc.pivot.y * zoom }}
                  >
                    <Crosshair size={23} />
                  </div>
                )}
              </div>
            </div>
            <div className="canvas-bottom">
              <span className="canvas-status">
                Frame {active + 1} / {doc.frames.length} · {current.duration} ms
                {hoverPixel ? ` · x ${hoverPixel.x}, y ${hoverPixel.y}` : ''}
              </span>
              <div className="canvas-view-controls">
                <button
                  className="icon-button"
                  aria-label="Fit sprite canvas"
                  title="Fit the full canvas in the preview"
                  onClick={fitCanvas}
                >
                  <Maximize size={14} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Decrease sprite zoom"
                  title="Zoom out (preview only)"
                  disabled={zoom <= 1 / 32}
                  onClick={() =>
                    setZoom(
                      zoom > 1
                        ? Math.max(1, zoom - 1)
                        : Math.max(1 / 32, 2 ** (Math.ceil(Math.log2(zoom)) - 1)),
                    )
                  }
                >
                  <Minus size={14} />
                </button>
                <span>{zoom < 1 ? `1/${Math.round(1 / zoom)}` : zoom}×</span>
                <button
                  className="icon-button"
                  aria-label="Increase sprite zoom"
                  title="Zoom in (preview only)"
                  disabled={zoom >= 24}
                  onClick={() =>
                    setZoom(
                      zoom < 1
                        ? Math.min(1, 2 ** (Math.floor(Math.log2(zoom)) + 1))
                        : Math.min(24, zoom + 1),
                    )
                  }
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
          </div>
          <section className="sprite-timeline">
            <div className="sprite-transport">
              <button
                className="play-button"
                aria-label={playing ? 'Pause sprite animation' : 'Play sprite animation'}
                title="Play / pause (Space)"
                disabled={working || openingFile}
                onClick={() => setPlaying(!playing)}
              >
                {playing ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <label className="sprite-range">
                <span>Animation range</span>
                <select
                  aria-label="Preview animation"
                  value={playTag}
                  onChange={(e) => {
                    setPlaying(false);
                    setPlayTag(e.target.value);
                  }}
                >
                  <option value="">All frames</option>
                  {doc.tags.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="toggle-label">
                <input
                  aria-label="Loop sprite playback"
                  type="checkbox"
                  checked={loop}
                  onChange={(e) => setLoop(e.target.checked)}
                />{' '}
                Loop
              </label>
              <span className="sprite-timing">{totalDuration} ms</span>
              <div className="sprite-frame-actions">
                <button
                  className="icon-button"
                  title="Blank frame"
                  aria-label="Add blank frame"
                  disabled={playing || working || openingFile}
                  onClick={() => addFrame(false)}
                >
                  <Plus size={16} />
                </button>
                <button
                  className="icon-button"
                  title="Duplicate frame"
                  aria-label="Duplicate sprite frame"
                  disabled={playing || working || openingFile}
                  onClick={() => addFrame(true)}
                >
                  <Copy size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Move frame left"
                  title="Move selected frame earlier"
                  disabled={active === 0 || playing || working || openingFile}
                  onClick={() => {
                    commit(moveFrame(doc, active, active - 1));
                    setActive(active - 1);
                  }}
                >
                  <ArrowLeft size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Move frame right"
                  title="Move selected frame later"
                  disabled={active === doc.frames.length - 1 || playing || working || openingFile}
                  onClick={() => {
                    commit(moveFrame(doc, active, active + 1));
                    setActive(active + 1);
                  }}
                >
                  <ArrowRight size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Delete sprite frame"
                  title="Delete selected frame (can be undone)"
                  disabled={doc.frames.length === 1 || playing || working || openingFile}
                  onClick={() => {
                    const next = deleteFrame(doc, active);
                    commit(next);
                    setActive(Math.min(active, next.frames.length - 1));
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
            <div className="sprite-frame-strip" ref={frameStripRef} aria-label="Animation frames">
              {doc.frames.map((frame, i) => (
                <button
                  key={frame.id}
                  className={`sprite-frame ${active === i ? 'active' : ''}`}
                  aria-label={`Select sprite frame ${i + 1}`}
                  aria-pressed={active === i}
                  tabIndex={active === i ? 0 : -1}
                  title={`Frame ${i + 1} · ${frame.duration} ms. Click to select and pause.`}
                  onClick={() => {
                    setPlaying(false);
                    setActive(i);
                  }}
                >
                  <span>{i + 1}</span>
                  <Thumbnail pixels={frame.pixels} width={doc.width} height={doc.height} />
                  <small>{frame.duration} ms</small>
                </button>
              ))}
            </div>
            <div className="sprite-duration-row">
              <label>
                Frame {active + 1} duration
                <input
                  aria-label="Frame duration (ms)"
                  disabled={playing || working || openingFile}
                  type="number"
                  min="10"
                  max="60000"
                  step="1"
                  key={`${current.id}-${current.duration}`}
                  defaultValue={current.duration}
                  onBlur={(e) => {
                    const duration = +e.target.value;
                    if (Number.isInteger(duration) && duration >= 10 && duration <= 60000)
                      updateDuration(duration);
                    else {
                      e.target.value = String(current.duration);
                      setError('Frame duration must be a whole number from 10 to 60,000 ms.');
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                />{' '}
                ms
              </label>
            </div>
          </section>
        </main>
        <FrameInspector
          tools={
            <fieldset disabled={working || playing || openingFile}>
              <section
                className="sprite-section sprite-conversion-actions"
                aria-label="Animation conversion"
              >
                <h2>Frame tools</h2>
                <div>
                  <button
                    className="button primary"
                    onClick={() => setShowFrameConversion('convert')}
                  >
                    Pixelate &amp; remove background…
                  </button>
                </div>
              </section>
              <section className="sprite-section sprite-swatches">
                <h2>Swatches</h2>
                <div className="sprite-palette">
                  {colors.map((c) => (
                    <button
                      key={c}
                      style={{ background: c }}
                      title={c}
                      aria-label={`Draw with ${c}`}
                      className={color === c ? 'selected' : ''}
                      aria-pressed={color === c}
                      onClick={() => setColor(c)}
                    />
                  ))}
                  <span>{color.toUpperCase()}</span>
                </div>
              </section>
              <details className="sprite-section sprite-details">
                <summary>
                  <h2>Canvas size</h2>
                </summary>
                <div className="sprite-details-content">
                  <div className="sprite-field-grid">
                    <label>
                      Width
                      <input
                        aria-label="Sprite canvas width"
                        type="number"
                        min="1"
                        max="512"
                        value={canvasWidth}
                        onChange={(e) => setCanvasWidth(+e.target.value)}
                      />
                    </label>
                    <label>
                      Height
                      <input
                        aria-label="Sprite canvas height"
                        type="number"
                        min="1"
                        max="512"
                        value={canvasHeight}
                        onChange={(e) => setCanvasHeight(+e.target.value)}
                      />
                    </label>
                  </div>
                  <button
                    className="button subtle small full"
                    onClick={async () => {
                      try {
                        const resized = resizeCanvas(doc, canvasWidth, canvasHeight);
                        if (
                          (canvasWidth < doc.width || canvasHeight < doc.height) &&
                          !(await confirm({
                            title: 'Crop all frames?',
                            description: `Resizing to ${canvasWidth} × ${canvasHeight} px removes pixels outside the new canvas on every frame. The top-left stays fixed. You can undo this crop.`,
                            action: 'Crop frames',
                          }))
                        )
                          return;
                        commit(resized);
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    Pad / crop canvas
                  </button>
                  <p className="help-text">
                    Resize anchors at top-left and never resamples. Smaller dimensions crop pixels.
                  </p>
                </div>
              </details>{' '}
              <details className="sprite-section sprite-details" id="sprite-pivot-settings">
                <summary>
                  <h2 className="pivot-heading">
                    <Crosshair size={15} /> Shared pivot
                  </h2>
                </summary>
                <div className="sprite-details-content">
                  <p className="help-text">
                    The game origin for every frame, measured from the top-left. Changes metadata
                    only; pixels stay in place. The amber guide is never exported.
                  </p>
                  <div className="sprite-field-grid">
                    <label>
                      Pivot X (px)
                      <input
                        aria-label="Pivot X"
                        type="number"
                        min="0"
                        max={doc.width}
                        value={doc.pivot.x}
                        onChange={(e) =>
                          commit({ ...doc, pivot: { ...doc.pivot, x: +e.target.value } })
                        }
                      />
                    </label>
                    <label>
                      Pivot Y (px)
                      <input
                        aria-label="Pivot Y"
                        type="number"
                        min="0"
                        max={doc.height}
                        value={doc.pivot.y}
                        onChange={(e) =>
                          commit({ ...doc, pivot: { ...doc.pivot, y: +e.target.value } })
                        }
                      />
                    </label>
                  </div>
                  <div className="sprite-small-actions">
                    <button
                      className="text-button"
                      onClick={() =>
                        commit({
                          ...doc,
                          pivot: { x: Math.floor(doc.width / 2), y: Math.floor(doc.height / 2) },
                        })
                      }
                    >
                      Center pivot
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        commit({ ...doc, pivot: { x: Math.floor(doc.width / 2), y: doc.height } })
                      }
                    >
                      Feet / bottom pivot
                    </button>
                  </div>
                </div>
              </details>
              <details className="sprite-section sprite-details">
                <summary>
                  <h2>Keyboard shortcuts</h2>
                </summary>
                <div className="sprite-details-content sprite-shortcut-list">
                  <span>
                    <kbd>B</kbd> Pencil <kbd>E</kbd> Eraser <kbd>G</kbd> Fill
                  </span>
                  <span>
                    <kbd>I</kbd> Sample color <kbd>P</kbd> Set pivot
                  </span>
                  <span>
                    <kbd>Space</kbd> Play / pause
                  </span>
                  <span>
                    <kbd>←</kbd> <kbd>→</kbd> Select frame
                  </span>
                  <span>
                    <kbd>Ctrl/⌘ Z</kbd> Undo <kbd>⇧ Z</kbd> Redo
                  </span>
                </div>
              </details>
            </fieldset>
          }
          animation={
            <fieldset disabled={working || playing || openingFile}>
              <section className="sprite-section">
                <h2>Frame timing</h2>
                <div className="sprite-duration-row sprite-bulk-timing">
                  {' '}
                  <label>
                    Set all frames to
                    <select
                      aria-label="All frames FPS"
                      value={allFps}
                      onChange={(e) => setAllFps(+e.target.value)}
                    >
                      {[6, 8, 10, 12, 15, 24, 30, 60].map((f) => (
                        <option key={f} value={f}>
                          {f} FPS
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="button subtle small"
                    disabled={playing || working || openingFile}
                    onClick={() =>
                      commit({
                        ...doc,
                        frames: doc.frames.map((f) => ({
                          ...f,
                          duration: Math.round(1000 / allFps),
                        })),
                      })
                    }
                  >
                    Apply timing
                  </button>
                </div>
                <p className="help-text">
                  Applies one duration to every frame. Individual timing is below the timeline.
                </p>
              </section>
              <details className="sprite-section sprite-details">
                <summary>
                  <h2>Animation tags</h2>
                </summary>
                <div className="sprite-details-content">
                  <p className="help-text">
                    Name frame ranges such as idle or walk. Choose a tag beside Play to preview it;
                    all tags are included in the exported JSON.
                  </p>
                  {!doc.tags.length && (
                    <p className="help-text">
                      No animation tags yet. All frames will still export.
                    </p>
                  )}
                  <div className="sprite-tag-list">
                    {doc.tags.map((t) => (
                      <div key={t.name}>
                        <span>
                          <b>{t.name}</b>
                          <small>
                            {t.from + 1}–{t.to + 1} · {t.direction}
                          </small>
                        </span>
                        <button
                          className="icon-button"
                          aria-label={`Delete animation ${t.name}`}
                          onClick={() => {
                            commit({ ...doc, tags: doc.tags.filter((tag) => tag.name !== t.name) });
                            if (playTag === t.name) setPlayTag('');
                          }}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <label className="text-field">
                    <span>Name</span>
                    <input
                      aria-label="Animation tag name"
                      maxLength={60}
                      value={tagName}
                      onChange={(e) => setTagName(e.target.value)}
                    />
                  </label>
                  <div className="sprite-field-grid">
                    <label>
                      First frame
                      <input
                        aria-label="Animation first frame"
                        type="number"
                        min="1"
                        max={doc.frames.length}
                        value={tagFrom}
                        onChange={(e) => setTagFrom(+e.target.value)}
                      />
                    </label>
                    <label>
                      Last frame
                      <input
                        aria-label="Animation last frame"
                        type="number"
                        min="1"
                        max={doc.frames.length}
                        value={tagTo}
                        onChange={(e) => setTagTo(+e.target.value)}
                      />
                    </label>
                  </div>
                  <label className="select-field">
                    <span>Playback direction</span>
                    <select
                      aria-label="Animation direction"
                      value={tagDirection}
                      onChange={(e) => setTagDirection(e.target.value as AnimationTag['direction'])}
                    >
                      <option value="forward">Forward</option>
                      <option value="reverse">Reverse</option>
                      <option value="pingpong">Ping-pong</option>
                    </select>
                  </label>
                  <button
                    className="button subtle full"
                    onClick={() =>
                      commit({
                        ...doc,
                        tags: [
                          ...doc.tags,
                          {
                            name: tagName.trim(),
                            from: tagFrom - 1,
                            to: tagTo - 1,
                            direction: tagDirection,
                          },
                        ],
                      })
                    }
                  >
                    <Plus size={14} /> Add animation
                  </button>
                </div>
              </details>{' '}
              <details className="sprite-section sprite-details">
                <summary>
                  <h2>New or import frames</h2>
                </summary>
                <div className="sprite-details-content">
                  <label className="select-field">
                    <span>Import type</span>
                    <select
                      aria-label="Sprite import type"
                      value={importMode}
                      onChange={(e) => setImportMode(e.target.value as 'frames' | 'sheet' | 'gif')}
                    >
                      <option value="frames">PNG / WebP frame sequence</option>
                      <option value="sheet">Sprite sheet · uniform grid</option>
                      <option value="gif">Animated GIF · original timing</option>
                    </select>
                  </label>
                  {importMode === 'sheet' && (
                    <div className="sprite-field-grid">
                      {(
                        [
                          ['Cell width', cellW, setCellW, 1],
                          ['Cell height', cellH, setCellH, 1],
                          ['Cell gap', cellGap, setCellGap, 0],
                          ['Sheet margin', cellMargin, setCellMargin, 0],
                          ['Frame count', cellCount, setCellCount, 1],
                        ] as const
                      ).map(([label, value, setter, min]) => (
                        <label key={label}>
                          {label}
                          <input
                            aria-label={label}
                            type="number"
                            min={min}
                            max={label === 'Frame count' ? 256 : 512}
                            value={value}
                            onChange={(e) => setter(+e.target.value)}
                          />
                        </label>
                      ))}
                    </div>
                  )}
                  <button className="button subtle full" onClick={() => filesRef.current?.click()}>
                    <FolderOpen size={14} /> Import{' '}
                    {importMode === 'gif'
                      ? 'GIF'
                      : importMode === 'frames'
                        ? 'frames'
                        : 'sprite sheet'}
                  </button>
                  <div className="sprite-small-actions">
                    <button
                      className="text-button"
                      onClick={() => void replace(createDocument(32, 32))}
                    >
                      New 32 × 32
                    </button>
                    <button className="text-button" onClick={() => void replace(sampleSprite())}>
                      Load sample animation
                    </button>
                  </div>
                  <p className="help-text">
                    Imports keep source pixels. Mixed frame sizes are padded at top-left. Save a
                    project before replacing your work.
                  </p>
                </div>
              </details>
            </fieldset>
          }
          exportSettings={
            <>
              <div className="sprite-export-options">
                <label className="select-field">
                  <span>Export format</span>
                  <select
                    aria-label="Game asset export format"
                    value={assetFormat}
                    disabled={working || openingFile}
                    onChange={(event) => {
                      const next = event.target.value as 'pack' | 'gif' | 'mov' | 'webm';
                      setAssetFormat(next);
                      onOutputFormatChange?.(next);
                    }}
                  >
                    <option value="pack">Game asset pack (.zip)</option>
                    <option value="gif">Animated GIF (.gif)</option>
                    <option value="mov" disabled={!desktop}>
                      MOV · ProRes 4444 alpha (.mov)
                    </option>
                    <option value="webm" disabled={!desktop}>
                      WebM · VP9 alpha (.webm)
                    </option>
                  </select>
                </label>
                {!desktop && (
                  <p className="help-text">MOV and WebM export are available in the desktop app.</p>
                )}
                {(assetFormat === 'mov' || assetFormat === 'webm') && (
                  <button
                    className="text-button"
                    onClick={onOpenSettings}
                    disabled={working || openingFile}
                  >
                    FFmpeg settings
                  </button>
                )}
                {assetFormat === 'pack' && (
                  <button
                    className="text-button"
                    onClick={() => {
                      revealInspector('export');
                      const heading = document.getElementById('sprite-export-settings');
                      const details = heading?.closest('details');
                      if (details) details.open = true;
                      heading?.scrollIntoView({ block: 'start' });
                      heading?.focus({ preventScroll: true });
                    }}
                  >
                    Sheet settings <ArrowRight size={12} />
                  </button>
                )}
                {assetFormat === 'gif' && (
                  <label className="select-field">
                    <span>GIF repeat</span>
                    <select
                      aria-label="GIF repeat"
                      value={doc.gifRepeat ?? 0}
                      disabled={working || playing || openingFile}
                      onChange={(event) => commit({ ...doc, gifRepeat: +event.target.value })}
                    >
                      <option value="0">Loop forever</option>
                      <option value="-1">Play once</option>
                      {(doc.gifRepeat ?? 0) > 0 && (
                        <option value={doc.gifRepeat}>Repeat {doc.gifRepeat} times</option>
                      )}
                    </select>
                  </label>
                )}

                <p className="export-description">
                  {assetFormat === 'gif' ? (
                    <>
                      Animated GIF · {order.length} frames · {doc.width} × {doc.height} px. On/off
                      transparency.
                      <br />
                      <small>
                        {playTag ? `Range: ${playTag}. ` : ''}Up to 255 opaque colors. Alpha below
                        50% becomes transparent; timing rounds to 10 ms. Pivot and tag metadata are
                        not included.
                      </small>
                    </>
                  ) : assetFormat === 'mov' || assetFormat === 'webm' ? (
                    <>
                      {assetFormat === 'mov'
                        ? 'MOV · ProRes 4444 with alpha'
                        : 'WebM · VP9 with alpha'}{' '}
                      · {doc.width} × {doc.height} px.
                      <br />
                      {order.length} frames · {totalDuration} ms from {playTag || 'All frames'}.
                      Original frame timing, one pass, no audio.
                      {assetFormat === 'webm' &&
                        (doc.width % 2 !== 0 || doc.height % 2 !== 0) &&
                        ' Odd dimensions are padded with transparency.'}
                    </>
                  ) : (
                    'ZIP · all frames and tags. Includes a 1× PNG sprite sheet, JSON metadata, PNG frames, and import notes. Timing, alpha, and pivot included.'
                  )}
                </p>
              </div>
              <fieldset disabled={working || playing || openingFile}>
                {' '}
                <details className="sprite-section sprite-details">
                  <summary>
                    <h2 id="sprite-export-settings" tabIndex={-1}>
                      Game asset export
                    </h2>
                  </summary>
                  <div className="sprite-details-content">
                    <div className="sprite-field-grid">
                      {(
                        [
                          ['Sheet columns', options.columns, 'columns', 1, 256],
                          ['Frame spacing', options.padding, 'padding', 0, 32],
                          ['Border margin', options.margin, 'margin', 0, 32],
                          ['Edge extrusion', options.extrude, 'extrude', 0, 4],
                        ] as const
                      ).map(([label, value, key, min, max]) => (
                        <label key={key}>
                          {label}
                          <input
                            aria-label={label}
                            type="number"
                            value={value}
                            min={min}
                            max={max}
                            onChange={(e) => setOptions((s) => ({ ...s, [key]: +e.target.value }))}
                          />
                        </label>
                      ))}
                    </div>
                    <label className="toggle-label">
                      <input
                        aria-label="Trim transparent frame borders"
                        type="checkbox"
                        checked={options.trim}
                        onChange={(e) => setOptions((s) => ({ ...s, trim: e.target.checked }))}
                      />{' '}
                      Trim transparent borders
                    </label>
                    <label className="toggle-label">
                      <input
                        aria-label="Power of two atlas"
                        type="checkbox"
                        checked={options.powerOfTwo}
                        onChange={(e) =>
                          setOptions((s) => ({ ...s, powerOfTwo: e.target.checked }))
                        }
                      />{' '}
                      Power-of-two atlas
                    </label>
                    <p className={atlasError ? 'inline-warning' : 'help-text'}>
                      {atlasError || atlasInfo}
                    </p>
                    <p className="help-text">
                      Spacing separates frames. Extrusion repeats edge pixels to reduce texture
                      seams. Trimming keeps the original size and pivot in JSON; frame PNGs stay
                      untrimmed.
                    </p>
                    <p className="help-text">
                      1× RGBA PNG atlas + Aseprite-style JSON + original-size PNG frames. Includes
                      durations, tags, trim offsets, source sizes, and pivot. No rotated frames or
                      burned-in guides.
                    </p>
                  </div>
                </details>
              </fieldset>
            </>
          }
          footer={
            <div className="sprite-export">
              <button
                className="sprite-export-summary"
                onClick={() => revealInspector('export')}
                title="Change export format and settings"
              >
                <span>
                  {assetFormat === 'pack'
                    ? 'Game asset pack'
                    : assetFormat === 'gif'
                      ? 'Animated GIF'
                      : assetFormat === 'mov'
                        ? 'MOV · ProRes 4444'
                        : 'WebM · VP9'}
                  <small>
                    {doc.width} × {doc.height} px ·{' '}
                    {assetFormat === 'pack' ? doc.frames.length : order.length} frames
                  </small>
                </span>
                <ArrowRight size={15} />
              </button>
              <button
                className="button primary full"
                disabled={
                  working ||
                  openingFile ||
                  (assetFormat === 'pack' && !!atlasError) ||
                  (!desktop && (assetFormat === 'mov' || assetFormat === 'webm'))
                }
                onClick={() =>
                  void run(async () => {
                    if (assetFormat === 'gif') {
                      const bytes = await encodeGif(doc, order, setWorkingLabel);
                      if (await saveBytes(bytes, `${safeName(doc.name)}.gif`, 'gif'))
                        setMessage(
                          `GIF exported · ${order.length} frames · ${doc.width} × ${doc.height} px. Your editable project is unchanged.`,
                        );
                    } else if (assetFormat === 'mov' || assetFormat === 'webm') {
                      const controller = new AbortController();
                      automationRevision.current.videoJob = { controller, encoding: false };
                      try {
                        const saved = await exportSpriteVideo({
                          doc,
                          order,
                          format: assetFormat,
                          ffmpeg,
                          signal: controller.signal,
                          progress: (progress) => {
                            const job = automationRevision.current.videoJob;
                            if (job) job.encoding = !!progress.encoding;
                            setWorkingLabel(progress.label);
                          },
                        });
                        setMessage(
                          saved
                            ? `${assetFormat === 'mov' ? 'MOV' : 'WebM'} exported · ${order.length} frames · ${totalDuration} ms. Frame timing and transparency included.`
                            : 'Video save cancelled. Your frame edits are kept.',
                        );
                      } catch (error) {
                        if (controller.signal.aborted)
                          setMessage('Video export cancelled. Your frame edits are kept.');
                        else throw error;
                      } finally {
                        automationRevision.current.videoJob = null;
                      }
                    } else if (await exportAssetPack(doc, options))
                      setMessage(
                        'Game asset pack exported. PNG atlas, JSON metadata, frame sequence, and import notes are included.',
                      );
                  })
                }
              >
                {working ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <ArrowDownToLine size={16} />
                )}{' '}
                {assetFormat === 'gif'
                  ? 'Export GIF'
                  : assetFormat === 'mov'
                    ? 'Export MOV'
                    : assetFormat === 'webm'
                      ? 'Export WebM'
                      : 'Export game asset pack'}
              </button>
            </div>
          }
        />
      </div>
      {(working || openingFile) && (
        <div className="sprite-working" role="status">
          <LoaderCircle size={16} className="spin" /> {openingFile ? 'Opening file…' : workingLabel}
          {working && automationRevision.current.videoJob && (
            <button
              className="text-button"
              disabled={automationRevision.current.videoJob.encoding}
              onClick={() =>
                automationRevision.current.videoJob?.controller.abort(
                  new DOMException('Cancelled', 'AbortError'),
                )
              }
            >
              Cancel export
            </button>
          )}
        </div>
      )}
      {confirmation}
      {(error || message) && (
        <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
          <span>
            {error ||
              (message ===
              'Conversion copied at 1× pixel size. Edit here; your converter source and settings are kept.'
                ? 'Adjusted frames ready. Your source media and settings are kept.'
                : message)}
          </span>
          <button
            aria-label="Dismiss sprite notification"
            onClick={() => {
              setError('');
              setMessage('');
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
