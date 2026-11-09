# Pixel animation and game-asset delivery

Research reviewed November 9, 2026. The initial target is engine-neutral export, as requested. This document separates source-backed behavior from Pixel Forge's design choices.

## Recommended delivery contract

The reviewed tools support related workflows rather than one universal game-animation file. Our recommendation is a lossless RGBA PNG atlas plus explicit frame metadata, accompanied by untrimmed PNG frames and an editable project. Engine importers can interpret timing, pivots, and trimming differently, so the export states each coordinate convention instead of relying on undocumented defaults.

| Deliverable            | Purpose                       | Pixel Forge behavior                                                                                  |
| ---------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `name.png`             | Runtime texture               | Logical-resolution, lossless RGBA atlas; no guides or UI overlays                                     |
| `name.json`            | Runtime animation data        | Aseprite-style JSON array with frame rectangles, durations, source size, trim offset, tags, and pivot |
| `frames/name-0000.png` | Portable fallback/interchange | Full-size, consistently aligned PNG frames                                                            |
| `IMPORT.txt`           | Handoff instructions          | Units, origin, filtering, scaling, alpha and reconstruction notes                                     |
| `name.pixelforge`      | Editable source               | Separate saved project containing original RGBA frames, timing, tags and pivot                        |

The runtime pack is deliberately distinct from editable source. Aseprite's native document contains frame and chunk structures for layers, cels and other editor information; PNG+JSON does not reproduce that document. Pixel Forge does not claim `.aseprite` writing support. [Aseprite file specification](https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md)

## Animation workflow

Aseprite's documented workflow includes drawing frames, copying or adding frames, navigating a timeline, previewing, and organizing ranges into animation tags. Onion skins expose neighboring poses during editing. Those operations informed the new workspace: pencil, eraser, fill, color sampling, undo/redo, onion skins, frame duplication/deletion/reordering, and playback. This version uses one flattened image per frame. Layers, linked cels, selections and a full drawing-tool suite remain future work. [Animation workflow](https://www.aseprite.org/docs/animation/), [onion skinning](https://www.aseprite.org/docs/onion-skinning/)

Automatic pixelation is a source-preparation step. It cannot decide whether a silhouette, pose, contact frame, anticipation or recovery is artistically suitable. Pixel Forge therefore imports converted images/video as editable frames instead of describing automatic conversion as finished production animation.

## Timing and named animations

Store a duration for each frame, not only one FPS value. Holds are part of an animation's timing. The editor exposes duration in milliseconds, and batch FPS is a convenience for assigning those durations. There is no mandatory game-art FPS implied by the presets. [Aseprite frame duration](https://www.aseprite.org/docs/frame-duration/)

Tags label frame ranges such as idle, walk, attack or effects. Aseprite documents forward, reverse and ping-pong directions; Pixel Forge supports those three. The editor displays frame numbers starting at one, while exported tag ranges are zero-based and inclusive. [Aseprite tags](https://www.aseprite.org/docs/tags/)

Godot demonstrates why explicit units matter: SpriteFrames durations are relative to animation speed. An importer must convert milliseconds using `relative_duration = duration_ms / 1000 × animation_fps` at playback speed one. Its documented ping-pong behavior holds each endpoint once per reversal; Pixel Forge likewise avoids duplicating endpoints in the playback order. [Godot SpriteFrames](https://docs.godotengine.org/en/stable/classes/class_spriteframes.html)

## Pixel-perfect rendering

Pixel-perfect output involves both the asset and the runtime camera. Pixel Forge edits on an integer pixel grid, previews at integer zoom, exports at 1× logical resolution, and snaps video stabilization translations to logical pixels when preparing sprite frames. Canvas resizing pads/crops; it does not interpolate the drawing.

An engine can still blur or unevenly scale a correct PNG. Keep a consistent pixels-per-unit convention and use point/nearest filtering with an appropriate viewport/camera. Unity supplies a Pixel Perfect Camera for resolution-dependent viewport scaling and motion stability. That runtime responsibility cannot be guaranteed by a file exporter. [Unity Pixel Perfect](https://docs.unity3d.com/Packages/com.unity.2d.pixel-perfect@5.0/manual/index.html)

For Unity, the documented sprite controls include pixels per unit, extraction of multiple sprites, pivot configuration, and Point filtering. Our starting recommendation for crisp 2D assets is Sprite/Multiple, Point, no mipmaps, and uncompressed textures, with a consistent project scale. These are import instructions, not a claim that Unity automatically reads this JSON. [Unity sprite texture settings](https://docs.unity.com/en-us/engine/6000.0/manual/materials-and-shaders/textures/textures-reference/texture-type-sprite)

Godot supports PNG and lossless texture import. Its documentation distinguishes 2D filtering on CanvasItem/project settings from image import options, and explains the tradeoffs of mipmaps and texture compression. Our default recommendation is lossless import, Nearest filtering, and mipmaps off for ordinary fixed-scale 2D pixel art; zooming or 3D use can justify different settings. [Godot image importing](https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_images.html)

## Canvas, pivot, and trim reconstruction

Keep a common untrimmed source canvas for an animation. Independently centering each visible pose can move feet or attachment points between frames. A fixed pivot gives the importer a stable origin, such as the character's feet. Aseprite slices can carry pivot information; Pixel Forge exports an origin slice plus explicit pixel-space pivot metadata. [Aseprite slices](https://www.aseprite.org/docs/slices/)

The export uses top-left pixel coordinates. `frame` is the sampled atlas rectangle; `spriteSourceSize` is the visible rectangle's offset and size within the original canvas; `sourceSize` is that canvas's dimensions. To reconstruct a trimmed frame, create the full transparent source canvas and place the atlas rectangle at the saved offset. Apply the shared pivot in that source space. Empty frames retain their durations and use a transparent 1×1 atlas rectangle.

The exporter uses fixed atlas cells and does not rotate rectangles. Trimming reduces the sampled rectangle, but does not compact the fixed-cell layout. This favors predictable reconstruction over maximum packing density.

## Padding, extrusion, and texture size

Aseprite exposes border, shape and inner padding, trimming, duplicate merging and edge extrusion. Those are distinct controls. Pixel Forge currently exposes transparent atlas margin, spacing between cells, and optional edge extrusion; duplicated edge pixels lie outside the metadata's sampled rectangle. They do not alter source-frame dimensions. [Aseprite CLI export options](https://www.aseprite.org/docs/cli/)

Power-of-two sizing is an optional export choice. It is not presented as a requirement for every engine or target. The first exporter limits a sheet to a configured maximum side length and 32 million total atlas pixels; it fails clearly instead of silently scaling or dropping frames. Multiple atlas pages and compact packing are future additions.

## Transparency and color

Keep RGBA for sprites and effects that need partial alpha. Hard-alpha conversion remains available for art intended to have binary edges. Chroma key creates transparency from a chosen color; it is not semantic segmentation. Editor overlays, onion skins, grids and pivot guides never enter exported frames.

The pack declares straight RGBA. An importer using premultiplied alpha must configure its material/blend mode consistently. Godot explicitly documents the material requirements of premultiplied alpha. Atlas extrusion and alpha-border correction address different sampling problems; neither substitutes for correct blending. [Godot alpha processing](https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_images.html#process-premult-alpha)

GIF is useful for a lightweight preview, but is not our runtime master: GIF89a uses indexed color tables and a transparent color index rather than full per-pixel RGBA alpha. The current game export therefore prioritizes PNG rather than adding a visually convenient but lossy interchange step. [GIF89a specification](https://www.w3.org/Graphics/GIF/spec-gif89a.txt)

## Interoperability and verification

Phaser documents loaders for Aseprite-style PNG/JSON data and animation construction from that metadata. That supports the choice of a familiar atlas schema while retaining engine-neutral PNG sequences as a fallback. Compatibility still depends on the specific importer and version; no engine-specific importer script is bundled in this release. [Phaser loader](https://docs.phaser.io/api-documentation/class/loader-loaderplugin#aseprite), [animation manager](https://docs.phaser.io/api-documentation/class/animations-animationmanager#createfromaseprite)

Automated checks reconstruct trimmed RGBA frames from atlas coordinates, verify empty-frame timing, distinguish extrusion from padding, check pivots and tag ranges, test exact timing boundaries, round-trip editable projects, and exercise drawing/undo/export through the UI. Engine-specific human acceptance still requires importing an exported pack into the intended game's engine and checking scale, filtering, timing, pivot and loop boundaries there.

## Next priorities

1. Metadata-aware atlas import and small engine-neutral loader examples.
2. Multi-layer cels, selection/move tools and more drawing primitives.
3. Loop seam comparison, pose references, and per-frame alignment nudges.
4. Compact multi-page atlases and optional per-animation sheets.
5. Attachment slices and optional hitbox/event data with explicit coordinate conventions.
6. Native `.aseprite` interchange only after a documented, tested subset is defined.
