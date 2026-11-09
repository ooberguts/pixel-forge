# Pixel Forge

A local image and video pixelation editor built with Tauri 2, React, TypeScript, and Rust. Built for macOS (Apple Silicon and Intel) and Windows x64. The converter and frame-based sprite workspace are separate tools; this is not a complete nonlinear video editor.

[Download the latest release](https://github.com/ooberguts/pixel-forge/releases/latest) · [Installation instructions](docs/INSTALL.md) · [Game-asset research](docs/GAME_ASSET_RESEARCH.md)

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
- Desktop WebM VP9 alpha and MOV ProRes 4444 export via a separately installed FFmpeg.
- Conversion preset save/load. Presets contain conversion settings; they do not save source files or anchor tracks.
- Game-asset workspace: integer-grid pencil/eraser/fill, color sampling, onion skins, undo/redo, frame ordering and duration, forward/reverse/ping-pong animation tags, and a shared pivot.
- PNG frame/regular-grid sprite-sheet import, image/video-to-sprite conversion, and editable `.pixelforge` projects.
- Game asset packs: 1× RGBA PNG atlas + Aseprite-style JSON + untrimmed PNG frames + import notes; optional trim, spacing, extrusion, and power-of-two sizing.
- Signed GitHub release updates, checked automatically on startup and every six hours, with user-triggered install/restart.

All media processing stays on the device. Update-enabled release builds contact GitHub for automatic checks; disable them in App settings if desired.

## Run the editor

Use Node.js 24 LTS or newer.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:1420. PNG and frame archive exports work in the browser. Native video encoding and application updates require the installed desktop app.

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

FFmpeg is not bundled or automatically downloaded by the app. Bundling a reviewed per-platform sidecar and its license notices is a later packaging task. The local `.tools/ffmpeg/` binary was downloaded only for development verification.

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
npm run version:set -- 0.2.1
npm run build
npm test
git add .
git commit -m "Release 0.2.1"
git tag v0.2.1
git push origin main --follow-tags
# If the tag was not annotated, push it explicitly:
git push origin v0.2.1
```

Use a new version/tag for each release. The version script synchronizes package, npm lockfile, Tauri, Cargo, and Cargo lockfile versions. Do not rewrite a published release with different binaries.

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

Browser tests cover RGBA PNG output, video scrubbing/anchors/chroma key/frame ZIP export, and narrow layouts. An optional native round-trip test verifies both encoder outputs contain transparent and opaque pixels:

```sh
PIXEL_FORGE_TEST_FFMPEG=/absolute/path/to/ffmpeg cargo test --manifest-path src-tauri/Cargo.toml -- --include-ignored
```

## Next development steps

1. Native input decoding for consistent MOV/WebM alpha across macOS and Windows; more real-world alpha fixtures.
2. Source-linked project files that preserve trim, anchor tracks, settings, and media references; undo/redo.
3. Automatic point tracking with manual correction for video stabilization.
4. Sprite layers, selection/move tools, metadata-aware atlas import, and batch image conversion.
5. Multiple clips, tracks, compositing, keyframed effects, and audio handling.
6. Reviewed FFmpeg sidecars, OS signing, and an end-to-end install/restart test between two published releases.

Research and design decisions: [docs/RESEARCH.md](docs/RESEARCH.md).
