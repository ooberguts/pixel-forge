# Install Pixel Forge

Download installers from [the latest GitHub release](https://github.com/ooberguts/pixel-forge/releases/latest). No Node.js, Rust, account, or source checkout is needed to use a packaged app.

## macOS

Requires macOS 12 or newer. Choose the build for your Mac:

- **Apple Silicon** (M1 or newer): the `.dmg` containing `aarch64` in its name.
- **Intel**: the `.dmg` containing `x64` in its name.

Open the DMG, drag **Pixel Forge** into **Applications**, eject the DMG, and launch Pixel Forge from Applications. Run the installed copy rather than the copy inside the disk image, so it has a writable location for updates.

The early app is ad-hoc signed and not Apple-notarized. macOS may block its first launch. Only proceed after confirming you downloaded it from `ooberguts/pixel-forge`; macOS provides an **Open Anyway** control in System Settings → Privacy & Security for a recently blocked app. Organization-managed Macs may require IT approval. Do not disable Gatekeeper system-wide.

## Windows

Use the `x64-setup.exe` installer on 64-bit Windows 10 or Windows 11. Run it and follow the installer. It installs for the current user. The installer can obtain Microsoft WebView2 if the runtime is missing; that step needs an internet connection.

This early installer does not have a paid Windows code-signing certificate, so Windows may show an unknown-publisher/SmartScreen notice. Verify the download's GitHub origin before choosing to proceed. Organization policies may require administrator or IT approval. Native Windows ARM installers are not supplied yet.

## Updates

Release builds check GitHub on startup and every six hours. When a newer release is available, use the **Update** button or open **App settings → Install & restart**. Finish an export and save any sprite project first: restarting closes the editing session. You can turn automatic checks off and use **Check for updates** manually.

Updates are downloaded as signed application artifacts and verified with the public key embedded in the installed build. The updater does not pull or run the repository's source code. A failed/offline background check leaves editing available.

If you have the original local **0.1.0** prototype, install the first GitHub release manually once. That prototype was built before the repository and updater key existed.

## Optional FFmpeg for encoded video

Image, sprite-sheet, sprite-project, and PNG-frame exports work without FFmpeg. WebM/MOV encoding requires a separate FFmpeg build containing `libvpx-vp9` and `prores_ks`.

Obtain FFmpeg from a trusted distribution linked by [the FFmpeg project](https://ffmpeg.org/download.html). In Pixel Forge's App settings, enter the full path to the executable. Examples:

- Apple Silicon Homebrew: `/opt/homebrew/bin/ffmpeg`
- Intel Homebrew: `/usr/local/bin/ffmpeg`
- Windows: `C:\ffmpeg\bin\ffmpeg.exe`

FFmpeg is not bundled in this release. Video input decoding depends on the codecs available to the system webview; ProRes input is not yet supported by the preview. PNG sequences and PNG atlases are the preferred game-asset delivery formats.

## Game assets

Use **Game assets** for the sprite editor. Use **Edit as game sprite** or **Create sprite animation** in the converter's export panel to send the current processed source into it. Existing image/video conversion controls remain available through **Converter**.

Exporting a game asset pack produces PNG atlas + JSON metadata + a PNG sequence + import instructions. Save `.pixelforge` separately to retain editable sprite frames, durations, animation tags and pivot. Engine-specific import behavior is described in [the game-asset research notes](GAME_ASSET_RESEARCH.md).
