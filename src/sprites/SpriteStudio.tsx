import { useEffect, useMemo, useRef, useState } from 'react';
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
  PaintBucket,
  Pencil,
  Pipette,
  Play,
  Pause,
  Plus,
  Redo2,
  Save,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { PALETTES, hexRGB, rgbHex } from '../engine';
import { APP_VERSION } from '../version';
import { saveBytes } from '../platform';
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
  exportAssetPack,
  frameCanvas,
  importPngFrames,
  importSheet,
  safeName,
} from './io';
import './sprites.css';

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
export default function SpriteStudio({
  initial,
  onBack,
  onChange,
}: {
  initial: SpriteDocument;
  onBack: () => void;
  onChange: (doc: SpriteDocument) => void;
}) {
  const [doc, setDoc] = useState(initial),
    [active, setActive] = useState(0);
  const [past, setPast] = useState<SpriteDocument[]>([]),
    [future, setFuture] = useState<SpriteDocument[]>([]);
  const [tool, setTool] = useState<Tool>('pencil'),
    [color, setColor] = useState('#c7ec95');
  const [zoom, setZoom] = useState(initial.width > 64 ? 4 : 10),
    [grid, setGrid] = useState(true),
    [onion, setOnion] = useState(false),
    [showPivot, setShowPivot] = useState(true);
  const [playing, setPlaying] = useState(false),
    [loop, setLoop] = useState(true),
    [playTag, setPlayTag] = useState('');
  const [options, setOptions] = useState(sheetDefaults),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [working, setWorking] = useState(false);
  const [tagName, setTagName] = useState('walk'),
    [tagFrom, setTagFrom] = useState(1),
    [tagTo, setTagTo] = useState(doc.frames.length),
    [tagDirection, setTagDirection] = useState<AnimationTag['direction']>('forward');
  const [canvasWidth, setCanvasWidth] = useState(doc.width),
    [canvasHeight, setCanvasHeight] = useState(doc.height),
    [allFps, setAllFps] = useState(12);
  const [importMode, setImportMode] = useState<'frames' | 'sheet'>('frames'),
    [cellW, setCellW] = useState(32),
    [cellH, setCellH] = useState(32),
    [cellGap, setCellGap] = useState(0),
    [cellMargin, setCellMargin] = useState(0),
    [cellCount, setCellCount] = useState(6);
  const canvasRef = useRef<HTMLCanvasElement>(null),
    filesRef = useRef<HTMLInputElement>(null),
    projectRef = useRef<HTMLInputElement>(null);
  const stroke = useRef<{
    pixels: Uint8ClampedArray;
    last: { x: number; y: number };
    frame: number;
  } | null>(null);
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
  const replace = (next: SpriteDocument) => {
    validateDocument(next);
    commit(next);
    setActive(0);
    setPlayTag('');
    setCanvasWidth(next.width);
    setCanvasHeight(next.height);
    setZoom(next.width > 64 ? 4 : 10);
    setTagTo(next.frames.length);
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
    if (!playing) return;
    let raf = 0;
    const start = performance.now();
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
  }, [playing, loop, doc, order, totalDuration]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLElement &&
        ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)
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
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((p) => !p);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setPlaying(false);
        setActive((i) => Math.max(0, i - 1));
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setPlaying(false);
        setActive((i) => Math.min(doc.frames.length - 1, i + 1));
      }
      const tools: Record<string, Tool> = {
        b: 'pencil',
        e: 'eraser',
        g: 'fill',
        i: 'sample',
        p: 'pivot',
      };
      if (tools[e.key]) setTool(tools[e.key]);
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
    if (playing || working || e.button !== 0) return;
    e.preventDefault();
    const p = point(e),
      i = (p.y * doc.width + p.x) * 4;
    if (tool === 'sample') {
      setColor(rgbHex([current.pixels[i], current.pixels[i + 1], current.pixels[i + 2]]));
      setTool('pencil');
      return;
    }
    if (tool === 'pivot') {
      commit({ ...doc, pivot: p });
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
    if (Number.isFinite(duration) && duration >= 10 && duration <= 60000)
      commit({ ...doc, frames: doc.frames.map((f, i) => (i === active ? { ...f, duration } : f)) });
  };
  const run = async (task: () => Promise<void>) => {
    setWorking(true);
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
  let atlasInfo = '';
  try {
    const plan = planAtlas(doc, options);
    atlasInfo = `${plan.width} × ${plan.height} px · ${plan.columns} columns · ${plan.rows} rows`;
  } catch (e) {
    atlasInfo = e instanceof Error ? e.message : String(e);
  }
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
      <input
        className="hidden"
        ref={filesRef}
        aria-label="Import sprite frames"
        type="file"
        multiple={importMode === 'frames'}
        accept="image/png,image/webp"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length)
            void run(async () => {
              replace(
                importMode === 'frames'
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
              setMessage('Frames imported at their original pixel resolution.');
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
              replace(decodeProject(new Uint8Array(await file.arrayBuffer())));
              setMessage('Sprite project opened.');
            });
          e.target.value = '';
        }}
      />
      <header className="topbar">
        <button className="button subtle small" onClick={onBack} disabled={working}>
          <ArrowLeft size={15} /> Converter
        </button>
        <div className="sprite-title">
          <b>Game assets</b>
          <span>Pixel Forge · {APP_VERSION}</span>
        </div>
        <div className="topbar-right">
          <button
            className="button subtle small"
            onClick={() => projectRef.current?.click()}
            disabled={working}
          >
            <FolderOpen size={14} /> Open project
          </button>
          <button
            className="button subtle small"
            disabled={working}
            onClick={() =>
              void run(async () => {
                if (
                  await saveBytes(
                    encodeProject(doc),
                    `${safeName(doc.name)}.pixelforge`,
                    'pixelforge',
                  )
                )
                  setMessage('Editable sprite project saved.');
              })
            }
          >
            <Save size={14} /> Save project
          </button>
        </div>
      </header>
      <div className="sprite-body">
        <main className="sprite-main">
          <div className="sprite-heading">
            <div>
              <h1>Sprite animation</h1>
              <p>
                {doc.width} × {doc.height} pixels · {doc.frames.length} frames · {totalDuration} ms
              </p>
            </div>
            <label className="sprite-name">
              Asset name
              <input
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
                    className={`icon-button ${tool === id ? 'is-on' : ''}`}
                    title={label}
                    aria-label={label}
                    aria-pressed={tool === id}
                    disabled={playing || working}
                    onClick={() => setTool(id)}
                  >
                    <Icon size={17} />
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
                  disabled={!past.length || playing || working}
                  onClick={undo}
                >
                  <Undo2 size={17} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Redo sprite edit"
                  disabled={!future.length || playing || working}
                  onClick={redo}
                >
                  <Redo2 size={17} />
                </button>
                <span className="thin-divider" />
                <button
                  className={`icon-button ${onion ? 'is-on' : ''}`}
                  aria-label="Toggle onion skin"
                  aria-pressed={onion}
                  onClick={() => setOnion(!onion)}
                >
                  <Layers2 size={17} />
                </button>
                <button
                  className={`icon-button ${grid ? 'is-on' : ''}`}
                  aria-label="Toggle sprite grid"
                  aria-pressed={grid}
                  onClick={() => setGrid(!grid)}
                >
                  <Grid2X2 size={17} />
                </button>
                <button
                  className={`icon-button ${showPivot ? 'is-on' : ''}`}
                  aria-label="Toggle pivot guide"
                  aria-pressed={showPivot}
                  onClick={() => setShowPivot(!showPivot)}
                >
                  <Crosshair size={17} />
                </button>
              </div>
            </div>
            <div className="sprite-viewport">
              <div
                className="sprite-canvas-wrap"
                style={{ width: doc.width * zoom, height: doc.height * zoom }}
              >
                <canvas
                  ref={canvasRef}
                  aria-label="Sprite drawing canvas"
                  width={doc.width}
                  height={doc.height}
                  onPointerDown={pointerDown}
                  onPointerMove={paint}
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
                Frame {active + 1} · {current.duration} ms · 1 px brush
              </span>
              <div className="canvas-view-controls">
                <button
                  className="icon-button"
                  aria-label="Decrease sprite zoom"
                  onClick={() => setZoom(Math.max(1, zoom - 1))}
                >
                  <Minus size={14} />
                </button>
                <span>{zoom}×</span>
                <button
                  className="icon-button"
                  aria-label="Increase sprite zoom"
                  onClick={() => setZoom(Math.min(24, zoom + 1))}
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
          </div>
          <div className="sprite-palette">
            {colors.map((c) => (
              <button
                key={c}
                style={{ background: c }}
                title={c}
                aria-label={`Draw with ${c}`}
                className={color === c ? 'selected' : ''}
                onClick={() => setColor(c)}
              />
            ))}
            <span>{color.toUpperCase()}</span>
          </div>
          <section className="sprite-timeline">
            <div className="sprite-transport">
              <button
                className="play-button"
                aria-label={playing ? 'Pause sprite animation' : 'Play sprite animation'}
                disabled={working}
                onClick={() => setPlaying(!playing)}
              >
                {playing ? <Pause size={16} /> : <Play size={16} />}
              </button>
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
                  disabled={playing || working}
                  onClick={() => addFrame(false)}
                >
                  <Plus size={16} />
                </button>
                <button
                  className="icon-button"
                  title="Duplicate frame"
                  aria-label="Duplicate sprite frame"
                  disabled={playing || working}
                  onClick={() => addFrame(true)}
                >
                  <Copy size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Move frame left"
                  disabled={active === 0 || playing || working}
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
                  disabled={active === doc.frames.length - 1 || playing || working}
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
                  disabled={doc.frames.length === 1 || playing || working}
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
            <div className="sprite-frame-strip">
              {doc.frames.map((frame, i) => (
                <button
                  key={frame.id}
                  className={`sprite-frame ${active === i ? 'active' : ''}`}
                  aria-label={`Select sprite frame ${i + 1}`}
                  aria-pressed={active === i}
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
                Selected frame duration
                <input
                  aria-label="Frame duration (ms)"
                  type="number"
                  min="10"
                  max="60000"
                  step="10"
                  value={current.duration}
                  onChange={(e) => updateDuration(+e.target.value)}
                />{' '}
                ms
              </label>
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
                disabled={playing || working}
                onClick={() =>
                  commit({
                    ...doc,
                    frames: doc.frames.map((f) => ({ ...f, duration: Math.round(1000 / allFps) })),
                  })
                }
              >
                Apply timing
              </button>
            </div>
          </section>
          <p className="sprite-shortcuts">
            B pencil · E eraser · G fill · I sample · P pivot · Space play · ← / → frame · Ctrl/⌘ Z
            undo
          </p>
        </main>
        <aside className="sprite-inspector">
          <fieldset disabled={working || playing}>
            <section className="sprite-section">
              <h2>Source frames</h2>
              <label className="select-field">
                <span>Import type</span>
                <select
                  aria-label="Sprite import type"
                  value={importMode}
                  onChange={(e) => setImportMode(e.target.value as 'frames' | 'sheet')}
                >
                  <option value="frames">PNG / WebP frame sequence</option>
                  <option value="sheet">Sprite sheet · uniform grid</option>
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
                {importMode === 'frames' ? 'frames' : 'sprite sheet'}
              </button>
              <div className="sprite-small-actions">
                <button className="text-button" onClick={() => replace(createDocument(32, 32))}>
                  New 32 × 32
                </button>
                <button className="text-button" onClick={() => replace(sampleSprite())}>
                  Load sample animation
                </button>
              </div>
              <p className="help-text">
                Imports keep source pixels. Mixed frame sizes are padded at top-left. Save a project
                before replacing your work.
              </p>
            </section>
            <section className="sprite-section">
              <h2>Canvas & pivot</h2>
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
                onClick={() => {
                  try {
                    commit(resizeCanvas(doc, canvasWidth, canvasHeight));
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
            </section>
            <section className="sprite-section">
              <h2>Animation tags</h2>
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
            </section>
            <section className="sprite-section">
              <h2>Game asset export</h2>
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
                  onChange={(e) => setOptions((s) => ({ ...s, powerOfTwo: e.target.checked }))}
                />{' '}
                Power-of-two atlas
              </label>
              <p className="help-text">{atlasInfo}</p>
              <p className="help-text">
                1× RGBA PNG atlas + Aseprite-style JSON + original-size PNG frames. Includes
                durations, tags, trim offsets, source sizes, and pivot. No rotated frames or
                burned-in guides.
              </p>
            </section>
          </fieldset>
          <div className="sprite-export">
            <button
              className="button primary full"
              disabled={working}
              onClick={() =>
                void run(async () => {
                  if (await exportAssetPack(doc, options))
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
              Export game asset pack
            </button>
            <span>Logical pixel resolution · lossless RGBA</span>
          </div>
        </aside>
      </div>
      {(error || message) && (
        <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
          <span>{error || message}</span>
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
