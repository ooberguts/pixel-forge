# Pixel Forge Studio Test

A local image, video, GIF, and pixel-art utility built with Tauri 2, React, TypeScript, and Rust for macOS (Apple Silicon and Intel) and Windows x64. Open media, adjust it, optionally edit individual frames, and choose an output format. GIF, video, and game-asset outputs share the same processing path.

[Download the latest release](https://github.com/ooberguts/pixel-forge/releases/latest) · [Installation instructions](docs/INSTALL.md) · [Game-asset research](docs/GAME_ASSET_RESEARCH.md)

Version 0.3.0 makes **Pixel Forge Studio Test** the canonical desktop app, incorporating the Studio interface and unified media workflow. The existing application identifier and signed-update channel are retained. The download link shows the currently published version; changes on `main` become available to installed users only after a release is published.

## Current features

- Images: PNG, JPEG, WebP, and browser-decodable SVG; resolution presets and aspect-preserving resizing.
- Original colors, deterministic automatic color reduction, four built-in palettes, and custom hex palettes.
- Ordered Bayer and Floyd–Steinberg dithering; brightness, contrast, and saturation controls.
- Source alpha preservation, hard sprite alpha, and chroma key with a color picker, on-image sampling, strength, and edge softness.
- Original/processed preview, checkerboard/light/dark backgrounds, pixel grid, and preview zoom.
- Video timeline, playback, frame stepping, trim range, and selectable export FPS.
- Manual stabilization: source-space anchor keyframes, a stationary output target, interpolated translation, and zoom. The same transform is applied in preview and exports.
- PNG image/current-frame export, scaled with nearest-neighbor sampling. Grid overlay is optional for these exports.
- RGBA PNG frame archives with a JSON timing/settings/anchor manifest.
- Desktop WebM VP9 alpha and MOV ProRes 4444 export from video, GIFs, or edited frames via FFmpeg, retaining individual frame durations.
- Conversion preset save/load. Presets contain conversion settings; they do not save source files or anchor tracks.
- Optional frame editor: integer-grid pencil/eraser/fill, color sampling, onion skins, undo/redo, frame ordering and duration, forward/reverse/ping-pong animation tags, and a shared pivot.
- PNG frame/regular-grid sprite-sheet import, image/video-to-sprite conversion, and editable `.pixelforge` projects.
- Animated GIF import with composited frames and original timing; pixel edits, frame reordering, timing changes, and GIF export.
- Pixelate & remove background: one before/after window for pixel width, palettes, dithering, and chroma key across an animation, with playback, direct color sampling, cancellation, and undo.
- Game asset packs: 1× RGBA PNG atlas + Aseprite-style JSON + untrimmed PNG frames + import notes; optional trim, spacing, extrusion, and power-of-two sizing.
- A canvas-first desktop layout, focused properties tabs, docked animation timeline, vertical pixel tools, and consistent blue selection states. Keyboard frame selection keeps focus and selection together; Fit supports large artwork without changing its pixels.
- Optional authenticated local API and bundled MCP adapter with 15 inspection/edit/export tools; remote AI clients connect through an SSH tunnel.
- Signed GitHub release updates, checked automatically on startup and every six hours, with user-triggered install/restart.

Media processing runs on the device. The API is off by default; a connected test or AI client can read the assets you make available through it. Update-enabled release builds contact GitHub for automatic checks; disable them in App settings if desired.

## One media workflow

1. **Open file:** Images, GIFs, and videos open in **Adjust media**. GIFs start at original size and colors, keeping their original frame timing.
2. **Adjust media:** Change pixel width, palette, dithering, color, transparency, or trim. **Remove background** opens chroma-key controls and lets you pick the background directly on the original preview. Choose an output here without entering the frame editor.
3. **Edit frames** is optional: paint, reorder frames, change timing, preview tags, or set pivots. Returning to **Adjust media** uses these edited RGBA frames as the source; **Return to original source** restores the source, settings, trim, and anchors kept before frame edits.
4. **Output format:** Choose animated GIF, MOV, WebM, PNG sequence, or game-asset pack. GIF/MOV/WebM/game-pack choices carry between views. Save `.pixelforge` separately when you want an editable project.

Examples:

- **GIF → background removal → MOV:** Open the GIF, keep its original pixel width and colors, choose **Remove background**, sample the background, adjust strength/softness, then select **MOV** in Export and export. MOV retains soft alpha and original timing; desktop MOV/WebM export requires a separately installed FFmpeg executable configured in App settings.
- **MP4 → pixelated GIF:** Open the MP4, choose pixel width and palette, set trim/FPS, select **Animated GIF**, and export directly.
- **MP4 or GIF → game assets:** Apply any adjustments, optionally edit frames, then choose **Game asset pack**. The ZIP contains a 1× RGBA sprite sheet, JSON timing/metadata, untrimmed PNG frames, and import notes. Expand sheet settings in the frame editor for spacing, trimming, extrusion, and layout.

Switching views retains work and undo history. Unchanged adjustments resume their existing edited frames. Changed adjustments ask before replacing prior frame edits; **Resume frame edits** returns to them without replacing. Returning to the original source warns before discarding newer adjustments. Save projects before closing: session retention is not autosave. PNG preview grid and exported grid remain separate.

### Timing, transparency, and limits

GIFs are reconstructed into complete RGBA frames including disposal behavior. Frame delays and repeat settings are retained; absent/zero delays use 100 ms. GIF/edited-frame sources preserve original timing through trims and export, and frame stepping follows their actual boundaries. Change individual durations in whole milliseconds in **Edit frames**; video sources are sampled at the chosen FPS. A trim that leaves a frame shorter than 10 ms is rejected rather than silently lengthened.

- GIF and game-pack outputs use logical 1× pixel dimensions. PNG sequences and native video support nearest-neighbor export scaling.
- GIF exports the selected frame range, allows up to 255 opaque colors, makes alpha below 50% transparent, and rounds timing to 10 ms. It cannot store pivots or tags.
- In Edit frames, **Animation range** controls preview and GIF/MOV/WebM output. Game asset packs always include all frames and animation tags.
- MOV preserves alpha and dimensions. WebM adds a transparent row/column when needed for even dimensions. Both are silent and use FFmpeg in the desktop app. Variable frame timings use an exact rational clock; unusually large clock expansions are rejected before encoding. Final encoding cannot currently be cancelled.
- GIF imports and editable-frame/GIF/game-pack paths retain the existing 512 × 512 px, 256-frame, and 16-million-pixel limits. GIF files are limited to 32 MiB. Video-to-PNG/native-video export supports up to 1,800 sampled frames.
- Source video codecs depend on the system preview decoder. Use H.264 MP4 or VP9 WebM; native ProRes input decoding is not implemented.

### API and MCP

In the desktop app, open **App settings → API & AI connections** and choose **Start connection**. Read-only access supports inspection and export; enable **Allow edits through the API** to permit changes. Edits require current document revisions, and imports/transfers require explicit replacement. Close settings before requesting edits.

**Copy MCP configuration** supplies the bundled adapter path, local API address, and session token. The AI client needs Node.js 24 or newer. For an AI client on another computer, run the adapter there and connect through an SSH tunnel. The app listens only on loopback, and stopping the connection expires its token. Setup, tool schemas, HTTP examples, and limits are in [API and AI connections](docs/AUTOMATION.md).

UI review and verification: [UX polish](docs/UX_POLISH.md).

## Run the editor

Use Node.js 24 LTS or newer.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:1420. Image, GIF, sprite project, and game asset exports work in the browser. Native video encoding, API connections, and application updates require the desktop app. After changing Rust code, rebuild/restart the desktop app; frontend hot reload does not add new native commands.

## Run or build the desktop app

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), including Rust. On Windows, install Microsoft C++ Build Tools and WebView2. On macOS, install the Xcode command line tools.

```sh
npm run desktop
npm run tauri build
```

For the isolated Rust toolchain used during development in this workspace, run this first in a terminal:

```sh
export RUSTUP_HOME="$PWD/.tools/rustup"
export CARGO_HOME="$PWD/.tools/cargo"
export PATH="$CARGO_HOME/bin:$PATH"
```

Those exports are unnecessary with a normal system Rust installation. `.tools/` is excluded from Git.

macOS app/DMG output is under `src-tauri/target/release/bundle/`. Build Windows installers on Windows or through the included GitHub Actions workflow. A Windows build has not yet been validated locally.

### FFmpeg

Install FFmpeg separately for desktop WebM/MOV export. In App settings, enter its full executable path; macOS GUI applications may not inherit the terminal's PATH. Typical paths are `/opt/homebrew/bin/ffmpeg`, `/usr/local/bin/ffmpeg`, or `C:\ffmpeg\bin\ffmpeg.exe`. The build must contain `libvpx-vp9` and `prores_ks`.

FFmpeg is not bundled or automatically downloaded by the app. A configured executable path is local to that installation and is not included in public release configuration. Development-only encoder paths do not apply to release builds. Bundling reviewed per-platform binaries and their license/source materials remains a separate packaging task; the local development encoder must not be redistributed.

## Video, alpha, and stabilization

1. Open a video using the video tool or Open file.
2. Set pixel width and palette. An adaptive video palette is learned from the first decoded source frame and reused across the clip.
3. Choose Preserve source alpha, or Chroma key for a solid background. Sample the original frame, then adjust strength and edge softness.
4. Seek to a useful frame and choose Set anchor. Click the feature that should stay stationary. The first point defines the stationary output target.
5. Seek to later frames and mark the same feature. The app interpolates the source feature's position and translates each output frame to the fixed target. Use zoom to reduce exposed edges. This is manual translation stabilization, not automatic tracking, rotation correction, or camera-motion analysis.
6. Set trim, FPS, format, and export scale. Export this frame as PNG saves the current processed frame; Export animation renders the trim range.

Export uses an independent video decoder so it does not move the preview playhead. The marker overlay is never burned into output. The fixed output frame retains the source aspect ratio; moved edges are transparent unless Make opaque is selected.

PNG frames preserve the alpha supplied by the decoder or created by chroma key. Not every system video decoder preserves alpha. ProRes input is not supported by the current preview decoder. For alpha-critical input, validate a short sample first; a native FFmpeg input pipeline and PNG-sequence import are planned. WebM alpha playback varies by player. ProRes 4444 is a useful editing interchange format; PNG frames are the most portable lossless RGBA output.

Current limits: 1,800 sampled frames per export, 240 MB of PNG data for ZIP exports, 32 megapixels per scaled output frame, and 4,096 logical pixels in height. WebM pads odd dimensions to even dimensions with transparent pixels. Encoded video can soften chroma edges because of its pixel format; PNG frames preserve exact RGBA pixels. Exports are silent; audio preservation, multiple clips, and layered compositing are not implemented. Cancellation works during frame rendering; the final FFmpeg encode must finish.

## GitHub and releases

The public repository is [ooberguts/pixel-forge](https://github.com/ooberguts/pixel-forge). The `main` branch contains ongoing source development. Installed applications update from published, signed releases, rather than every source commit.

- `check.yml` runs the editor tests and macOS/Windows desktop compile checks on source changes.
- `release.yml` builds Apple Silicon macOS, Intel macOS, and Windows x64 installers when a version tag is pushed. It creates a draft, uploads all signed artifacts, verifies the updater manifest contains all platforms, and publishes only after every build succeeds.
- App settings provide automatic-check preferences, manual checks, download progress, and Install & restart. Restarts close the current editing session; save sprite projects first. Installation is disabled while video is playing or an export is active.

To release a new version:

```sh
npm run version:set -- 0.3.0
npm run build
npm test
git add .
git commit -m "Release 0.3.0"
git tag v0.3.0
git push origin main --follow-tags
# If the tag was not annotated, push it explicitly:
git push origin v0.3.0
```

Use an unpublished version/tag for each release; the example prepares 0.3.0. Pushing its tag starts the release workflow, which publishes after all platform builds and manifest checks pass. The version script synchronizes package, npm lockfile, Tauri, Cargo, and Cargo lockfile versions. Do not rewrite a published release with different binaries. Keep the canonical `studio.pixelforge.desktop` identifier and existing updater key when changing the product's display name.

GitHub variable `TAURI_UPDATER_PUBLIC_KEY` and secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` hold release signing configuration. The private key is never committed or shipped. An encrypted local backup and its password are in ignored `.tools/signing/` with restricted permissions. Keep an additional secure offline backup: future releases must use the same updater key. Do not paste the private key into issues or chats.

For a local update-enabled build, set the same signing variables plus `GITHUB_REPOSITORY=ooberguts/pixel-forge`, then run:

```sh
npm run configure:updater
npm run tauri build -- --config src-tauri/tauri.updater.conf.json
```

Development builds work without updater configuration. Updater signatures are separate from OS signing: current macOS bundles are ad-hoc signed and not notarized, and Windows installers are unsigned. See [installation instructions](docs/INSTALL.md) and the official [macOS](https://v2.tauri.app/distribute/sign/macos/) / [Windows](https://v2.tauri.app/distribute/sign/windows/) signing guides.

## Verification

```sh
npm run build
npm test
npx playwright install chromium
npm run test:e2e
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

Tests cover RGBA PNG output, video anchors/chroma key/frame archives, GIF import/edit/export, workspace retention, keyboard/focus behavior, small-window layouts, and revision-checked automation edits. Node tests exercise MCP protocol handling and a real stdio connection to a temporary authenticated HTTP server. Native API tests cover authentication, access modes, request limits, cancellation, and shutdown. An optional native round-trip test verifies both encoder outputs contain transparent and opaque pixels:

```sh
PIXEL_FORGE_TEST_FFMPEG=/absolute/path/to/ffmpeg cargo test --manifest-path src-tauri/Cargo.toml native_codecs_preserve_alpha -- --ignored
PIXEL_FORGE_TEST_FFMPEG=/absolute/path/to/ffmpeg PIXEL_FORGE_TEST_FFPROBE=/absolute/path/to/ffprobe cargo test --manifest-path src-tauri/Cargo.toml timed_codecs_preserve_boundaries_final_duration_and_alpha -- --ignored
```

## Next development steps

1. Native input decoding for consistent MOV/WebM alpha across macOS and Windows; more real-world alpha fixtures.
2. Source-linked project files that preserve trim, anchor tracks, settings, and media references; undo/redo.
3. Automatic point tracking with manual correction for video stabilization.
4. Sprite layers, selection/move tools, metadata-aware atlas import, and batch image conversion.
5. Multiple clips, tracks, compositing, keyframed effects, and audio handling.
6. Reviewed FFmpeg sidecars, OS signing, and an end-to-end install/restart test between two published releases.

Research and design decisions: [docs/RESEARCH.md](docs/RESEARCH.md).
