# Pixel Forge Studio Test 0.3.0

The Studio interface becomes the canonical Pixel Forge desktop app. This version keeps the existing application identifier and signed-update channel, with the new product name **Pixel Forge Studio Test**.

- A compact canvas-first workspace with focused properties tabs, a docked timeline, clearer tools, and consistent selection and keyboard focus.
- One workflow for images, GIFs, videos, and game assets. Open media in **Adjust media**, optionally **Edit frames**, and choose an output. Frame edits can feed back into adjustments; replacement and original-source actions explain what they discard.
- Direct GIF background removal at original size, with color sampling, strength, and soft edges. Export GIF or MOV/WebM without creating a game asset project. MP4-to-pixelated-GIF and image/video-to-game-asset workflows use the same controls.
- Editable GIF frames with original timing, pixel tools, undo/redo, frame ordering, animation tags, and pivots. Whole-millisecond timing entry, keyboard frame navigation, and real GIF frame stepping improve precision.
- Per-frame-timed MOV/WebM output preserves animation timing and alpha. A VP9 buffering fix prevents truncated exports. PNG sequences, sprite sheets, JSON metadata, and editable `.pixelforge` projects remain available.
- Optional authenticated local API and bundled MCP adapter for testing and AI assistance. Read-only by default, with explicit edit access and revision checks. MCP clients require Node.js 24 or newer; remote clients connect through an SSH tunnel.

Download the `.dmg` for Apple Silicon (`aarch64`) or Intel (`x64`) macOS, or the `x64-setup.exe` installer for Windows. See [installation instructions](https://github.com/ooberguts/pixel-forge/blob/main/docs/INSTALL.md). The release page identifies which version has been published; source commits alone do not update installed apps.

MOV and WebM export require a separate FFmpeg installation containing `libvpx-vp9` and `prores_ks`; set its executable path in App settings on each computer. FFmpeg and development-only encoder paths are not bundled in public releases. PNG, GIF, projects, and game asset exports work without it. GIF transparency is on/off and timing rounds to 10 ms; native video output is silent. Save editable projects before closing: session retention is not autosave.

Installed release builds check for signed updates on startup and every six hours. Updates install when you choose **Install & restart** in App settings. Updater signatures are separate from operating-system signing: macOS builds remain ad-hoc signed and not notarized, and Windows installers remain unsigned.
