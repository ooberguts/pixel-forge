# Install Pixel Forge Studio Test

Download installers from [the latest GitHub release](https://github.com/ooberguts/pixel-forge/releases/latest). No Node.js, Rust, account, or source checkout is needed to use a packaged app.

The 0.3.0 app is named **Pixel Forge Studio Test**. Earlier releases are named **Pixel Forge**. Check the version on the release page: a source update on GitHub does not itself publish a new installer. The canonical application identifier and signed-update channel are retained across this name change.

## macOS

Requires macOS 12 or newer. Choose the build for your Mac:

- **Apple Silicon** (M1 or newer): the `.dmg` containing `aarch64` in its name.
- **Intel**: the `.dmg` containing `x64` in its name.

Open the DMG, drag **Pixel Forge Studio Test** into **Applications**, eject the DMG, and launch it from Applications. For an older release, use the Pixel Forge app supplied in that DMG. Run the installed copy rather than the copy inside the disk image, so it has a writable location for updates.

The early app is ad-hoc signed and not Apple-notarized. macOS may block its first launch. Only proceed after confirming you downloaded it from `ooberguts/pixel-forge`; macOS provides an **Open Anyway** control in System Settings → Privacy & Security for a recently blocked app. Organization-managed Macs may require IT approval. Do not disable Gatekeeper system-wide.

## Windows

Use the `x64-setup.exe` installer on 64-bit Windows 10 or Windows 11. Run it and follow the installer. It installs for the current user. The installer can obtain Microsoft WebView2 if the runtime is missing; that step needs an internet connection.

This early installer does not have a paid Windows code-signing certificate, so Windows may show an unknown-publisher/SmartScreen notice. Verify the download's GitHub origin before choosing to proceed. Organization policies may require administrator or IT approval. Native Windows ARM installers are not supplied yet.

## Updates

Release builds check GitHub on startup and every six hours. When a newer release is available, use the **Update** button or open **App settings → Install & restart**. Finish an export and save any sprite project first: restarting closes the editing session. You can turn automatic checks off and use **Check for updates** manually.

Updates are downloaded as signed application artifacts and verified with the public key embedded in the installed build. The updater does not pull or run the repository's source code. A failed/offline background check leaves editing available.

If you have the original local **0.1.0** prototype, install the first GitHub release manually once. That prototype was built before the repository and updater key existed.

Local preview bundles built under temporary test identifiers are separate from the canonical release app. Save their editable projects before switching to the installed release. A display-name change does not transfer work from an open preview session.

## Optional FFmpeg for encoded video

Image, GIF, sprite-sheet, sprite-project, and PNG-frame exports work without FFmpeg. WebM/MOV encoding requires a separate FFmpeg build containing `libvpx-vp9` and `prores_ks`.

Obtain FFmpeg from a distribution linked by [the FFmpeg project](https://ffmpeg.org/download.html). In **App settings**, enter the full path to the executable. Examples:

- Apple Silicon Homebrew: `/opt/homebrew/bin/ffmpeg`
- Intel Homebrew: `/usr/local/bin/ffmpeg`
- Windows: `C:\ffmpeg\bin\ffmpeg.exe`

FFmpeg is not bundled or automatically downloaded. Set its path on each computer; a path from another machine or a development build is not portable. Public release builds do not depend on the developer's local encoder path. Video input decoding depends on the codecs available to the system webview; ProRes input is not yet supported by the preview. PNG sequences and PNG atlases preserve exact RGBA for game assets.

## Adjust media, edit frames, and export

**Open file** loads images, GIFs, and videos in **Adjust media**. GIFs retain original size, colors, and frame timing. For GIF background removal, choose **Remove background**, sample the background in the original preview, and adjust strength and softness. Choose GIF or another output in Export; a game asset project is optional. Select MOV to preserve soft alpha and original timing once FFmpeg is configured.

Use **Edit frames** for pixel tools, frame ordering, timing, animation tags, and pivots. Switching views retains edits and undo history. Returning to Adjust media can use edited frames as a new source; replacement actions explain what will be discarded. In Edit frames, **Animation range** controls GIF/video export, while game asset packs contain all frames and tags.

Exporting a game asset pack produces PNG atlas + JSON metadata + a PNG sequence + import instructions. Save `.pixelforge` separately to retain editable sprite frames, durations, animation tags and pivot. Engine-specific import behavior is described in [the game-asset research notes](GAME_ASSET_RESEARCH.md).

Session retention is not autosave. Save projects before closing or installing an update. GIF output has binary transparency and 10 ms timing granularity; PNG game packs retain full RGBA and game metadata, while MOV/WebM retain alpha and individual frame timing without audio.
