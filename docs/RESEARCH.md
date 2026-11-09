# Research and implementation decisions

Reviewed November 6, 2026. This project is an independent implementation inspired by the workflows below; it does not copy either site's source or visual assets. The bundled landscape sample is drawn locally by project code.

| Reference                                                             | Relevant features                                                                                                                  | Application direction                                                                          |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Pixel Art Village](https://pixelartvillage.com/)                     | Pixel-size adjustment, brightness/contrast/saturation, built-in and custom palettes, grid, logical-resolution and enlarged exports | A compact image-conversion workflow with live feedback and clean integer scaling               |
| [MakeBead pixel converter](https://makebead.com/pixel-art-converter/) | Color limiting, multiple dithering methods, transparency, grid and craft-oriented PNG/PDF exports                                  | More detailed color/alpha controls without requiring every advanced control to remain expanded |

The first version implements deterministic median-cut color reduction, Bayer/Floyd–Steinberg dithering, and alpha-aware conversion. Printable pattern PDFs and bead-material palettes are outside this initial game-asset-oriented scope.

## Desktop delivery

[Tauri distribution](https://v2.tauri.app/distribute/) supports native installers. [Tauri's GitHub guide](https://v2.tauri.app/distribute/pipelines/github/) and the official [tauri-action](https://github.com/tauri-apps/tauri-action) describe release builds and update metadata. The project includes macOS arm64/x64 and Windows x64 build jobs. These are configured workflows, not evidence that those remote builds have passed.

The [Tauri updater](https://v2.tauri.app/plugin/updater/) verifies signed artifacts and can consume a static release manifest. Pixel Forge generates a build-time configuration pointing to the future repository's `releases/latest/download/latest.json`. No placeholder public key or source-pulling update mechanism is shipped. Release jobs create drafts for review before distribution.

## Video and transparency

The FFmpeg project's [encoder documentation](https://github.com/FFmpeg/FFmpeg/blob/master/doc/encoders.texi) describes ProRes profiles and alpha-bit controls. Its [VP9 alpha encoding change](https://ffmpeg.org/pipermail/ffmpeg-cvslog/2016-July/101177.html) documents alpha support in the libvpx wrapper. The initial native exporters use VP9 `yuva420p` for WebM and ProRes 4444 `yuva444p10le` for MOV. PNG sequences retain exact RGBA without video chroma subsampling.

Alpha preservation and background removal are separate operations. Existing alpha is preserved when the source decoder supplies it. Chroma key generates an alpha mask from a selected background color, with strength and feathering. Neither operation performs semantic subject segmentation.

For video, independently learning a palette for every frame can change color assignments over time. The implementation therefore fixes the palette from the first source frame and uses a deterministic mapping for all sampled frames. This reduces palette-driven flicker; it does not promise to eliminate motion aliasing or changing dither texture.

## Stationary markers

Manual anchor points are stored in normalized source coordinates at timestamps. Their positions interpolate linearly. Each output frame translates the interpolated point onto the first chosen point's stationary target. The renderer applies the same operation before pixelation in both preview and export. Exposed edges remain transparent. This design is intended for sprite framing and modest translation correction; optical flow, rotation, scale tracking, and automatic camera stabilization remain future work.

## Architecture

- `engine.ts`: grading, keyed alpha, palette generation, quantization, and dithering.
- `stabilization.ts`: normalized source anchors and interpolated frame transforms.
- `media.ts`: local media decoding and a shared frame renderer.
- `export.ts`: deterministic sampling, isolated decoding, RGBA frame archives, and native encoder handoff.
- `src-tauri/src/lib.rs`: temporary-frame lifecycle, FFmpeg invocation, atomic output replacement, and updater status.

The browser-decoder path was chosen to make the editor immediately testable with a small dependency footprint. A native FFmpeg decoder is the next architectural step for consistent support for alpha-bearing MOV/WebM inputs. The current UI reports codec failures and documents this limit instead of claiming universal video support.
