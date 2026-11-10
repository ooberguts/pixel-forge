mod automation;
use automation::{AutomationState, automation_start, automation_stop, automation_status, automation_respond, automation_mcp_path};
use std::{collections::HashMap, fs, io::Read, path::PathBuf, process::Command, sync::Mutex};
use tauri::{Manager, State};
use tempfile::{NamedTempFile, TempDir};

struct EncodeSession {
    frames: TempDir,
    output: PathBuf,
    fps: u32,
    format: String,
    ffmpeg: String,
    count: usize,
    frame_durations_ms: Option<Vec<u32>>,
    dimensions: Option<(u32, u32)>,
}
#[derive(Default)]
struct EncodeState(Mutex<HashMap<String, EncodeSession>>);

#[tauri::command]
fn updater_configured(app: tauri::AppHandle) -> bool {
    app.config().plugins.0.get("updater").is_some_and(|v| {
        v.get("pubkey").and_then(|k| k.as_str()).is_some_and(|k| !k.is_empty())
            && v.get("endpoints").and_then(|e| e.as_array()).is_some_and(|e| !e.is_empty())
    })
}

const MAX_CLOCK_FRAMES: u64 = 100_000;
const MAX_CLOCK_PIXELS: u64 = 512_000_000;

#[derive(Debug, PartialEq)]
struct TimingPlan {
    tick_ms: u32,
    frames: u64,
}

fn timing_plan(durations: &[u32]) -> Result<TimingPlan, String> {
    if durations.is_empty() || durations.len() > 1800 || durations.iter().any(|&duration| !(10..=60_000).contains(&duration)) {
        return Err("Provide 1–1,800 frame durations, each a whole number from 10 to 60,000 ms.".into());
    }
    fn gcd(mut a: u32, mut b: u32) -> u32 {
        while b != 0 { let next = a % b; a = b; b = next; }
        a
    }
    let tick_ms = durations.iter().copied().reduce(gcd).expect("nonempty durations validated");
    let frames = durations.iter().map(|&duration| u64::from(duration / tick_ms)).sum();
    if frames > MAX_CLOCK_FRAMES {
        return Err("Exact frame timing would require more than 100,000 encoded frames. Shorten the animation or use frame durations with a larger common interval; timing will not be rounded.".into());
    }
    Ok(TimingPlan { tick_ms, frames })
}

fn png_dimensions(png: &[u8]) -> Result<(u32, u32), String> {
    if png.len() < 24 || !png.starts_with(b"\x89PNG\r\n\x1a\n") || &png[12..16] != b"IHDR" {
        return Err("Invalid PNG frame header.".into());
    }
    let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 32_000_000 {
        return Err("Video frames must be nonempty and at most 32 megapixels.".into());
    }
    Ok((width, height))
}

fn validate_clock_work(dimensions: (u32, u32), plan: &TimingPlan, format: &str) -> Result<(), String> {
    let (mut width, mut height) = (u64::from(dimensions.0), u64::from(dimensions.1));
    if format == "webm" { width += width % 2; height += height % 2; }
    if width * height * plan.frames > MAX_CLOCK_PIXELS {
        return Err("Exact timing at this size exceeds the 512-million-pixel video encoding limit. Reduce export scale or pixel size, shorten the animation, or use simpler frame durations. Timing will not be rounded.".into());
    }
    Ok(())
}

#[tauri::command]
fn video_export_capabilities() -> serde_json::Value {
    serde_json::json!({"frameDurationsMs":true,"formats":["mov","webm"],"maxClockFrames":MAX_CLOCK_FRAMES,"maxClockPixels":MAX_CLOCK_PIXELS})
}

fn resolve_ffmpeg(configured: &str, resources: Option<PathBuf>) -> String {
    #[cfg(debug_assertions)]
    let local = option_env!("PIXEL_FORGE_LOCAL_FFMPEG").map(PathBuf::from);
    #[cfg(not(debug_assertions))]
    let local = None;
    resolve_ffmpeg_candidates(configured, resources, local)
}

fn resolve_ffmpeg_candidates(configured: &str, resources: Option<PathBuf>, local: Option<PathBuf>) -> String {
    if configured.trim() == "ffmpeg" {
        if let Some(resources) = resources {
            let bundled = resources.join("bin").join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
            if bundled.is_file() { return bundled.to_string_lossy().into_owned(); }
        }
        // A local development build may point at an existing test-only encoder. This path is
        // never included in release builds and no encoder binary is copied or redistributed.
        if let Some(local) = local {
            if local.is_file() { return local.to_string_lossy().into_owned(); }
        }
    }
    configured.to_owned()
}

#[tauri::command]
fn begin_encode(app: tauri::AppHandle, output: String, fps: u32, format: String, ffmpeg: String, frame_durations_ms: Option<Vec<u32>>, state: State<'_, EncodeState>) -> Result<String, String> {
    if fps == 0 || fps > 60 || !["webm", "mov"].contains(&format.as_str()) {
        return Err("Invalid video format or frame rate.".into());
    }
    if let Some(durations) = &frame_durations_ms { timing_plan(durations)?; }
    let path = PathBuf::from(&output);
    if !path.is_absolute() || path.extension().and_then(|s| s.to_str()) != Some(format.as_str()) {
        return Err("Select an absolute output path with the correct extension.".into());
    }
    if ffmpeg.trim().is_empty() {
        return Err("Set the FFmpeg executable path in App settings.".into());
    }
    let ffmpeg = resolve_ffmpeg(&ffmpeg, app.path().resource_dir().ok());
    let id = uuid::Uuid::new_v4().to_string();
    let session = EncodeSession {
        frames: tempfile::Builder::new().prefix("pixel-forge-").tempdir().map_err(|e| e.to_string())?,
        output: path, fps, format, ffmpeg, count: 0, frame_durations_ms, dimensions: None,
    };
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    if !sessions.is_empty() { return Err("Another video export is already active.".into()); }
    sessions.insert(id.clone(), session);
    Ok(id)
}

#[tauri::command]
fn write_encode_frame(id: String, index: usize, png: Vec<u8>, state: State<'_, EncodeState>) -> Result<(), String> {
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("Video export session expired.")?;
    if index != session.count || index >= 1800 || png.len() > 64 * 1024 * 1024 || !png.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Invalid or out-of-order PNG frame.".into());
    }
    if let Some(durations) = &session.frame_durations_ms {
        if index >= durations.len() { return Err("More PNG frames were supplied than frame durations.".into()); }
        let dimensions = png_dimensions(&png)?;
        if session.dimensions.is_some_and(|previous| previous != dimensions) {
            return Err("All animation frames must have the same pixel dimensions.".into());
        }
        validate_clock_work(dimensions, &timing_plan(durations)?, &session.format)?;
        session.dimensions = Some(dimensions);
    }
    fs::write(session.frames.path().join(format!("frame-{index:06}.png")), &png).map_err(|e| e.to_string())?;
    session.count += 1;
    Ok(())
}

#[tauri::command]
fn abort_encode(id: String, state: State<'_, EncodeState>) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}

fn encode(session: EncodeSession) -> Result<(), String> {
    if session.count == 0 { return Err("No frames to encode.".into()); }
    let timed = if let Some(durations) = &session.frame_durations_ms {
        let plan = timing_plan(durations)?;
        if durations.len() != session.count { return Err("The PNG frame count does not match the frame durations. Export was not saved.".into()); }
        let mut dimensions = None;
        for index in 0..session.count {
            let mut header = [0u8; 24];
            fs::File::open(session.frames.path().join(format!("frame-{index:06}.png")))
                .and_then(|mut file| file.read_exact(&mut header)).map_err(|error| error.to_string())?;
            let current = png_dimensions(&header)?;
            if dimensions.is_some_and(|previous| previous != current) { return Err("All animation frames must have the same pixel dimensions.".into()); }
            validate_clock_work(current, &plan, &session.format)?;
            dimensions = Some(current);
        }
        // An exact rational clock avoids image-demuxer/VFR final-packet duration guesses.
        // Reuse each source PNG for its number of clock ticks; no resampling or quantization.
        let mut list = String::from("ffconcat version 1.0\n");
        for (index, duration) in durations.iter().enumerate() {
            let line = format!("file frame-{index:06}.png\n");
            for _ in 0..duration / plan.tick_ms { list.push_str(&line); }
        }
        let path = session.frames.path().join("timing.ffconcat");
        fs::write(&path, list).map_err(|error| error.to_string())?;
        Some((plan, path))
    } else { None };
    let parent = session.output.parent().ok_or("Invalid output directory.")?;
    // Encode to our own temporary output. A failed encode never replaces the user's file.
    let temporary: NamedTempFile = tempfile::Builder::new().prefix(".pixel-forge-")
        .suffix(&format!(".{}", session.format)).tempfile_in(parent).map_err(|e| e.to_string())?;
    let mut command = Command::new(&session.ffmpeg);
    command.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"]);
    if let Some((plan, list)) = timed {
        // -r on INPUT assigns one rational-clock timestamp to each listed PNG. Pass those
        // frames through unchanged: CFR sync would reuse PNG packet durations and shift edits.
        command.args(["-r", &format!("1000/{}", plan.tick_ms), "-f", "concat", "-safe", "1", "-i"])
            .arg(list).args(["-vsync", "0", "-frames:v", &plan.frames.to_string()]);
    } else {
        command.args(["-framerate", &session.fps.to_string(), "-i"])
            .arg(session.frames.path().join("frame-%06d.png"));
    }
    if session.format == "webm" {
        // Disable lookahead: older libvpx builds can leave delayed alpha packets unflushed
        // when FFmpeg reaches the explicit frame limit, silently truncating animations.
        command.args(["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2:color=black@0", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-lossless", "1", "-auto-alt-ref", "0", "-lag-in-frames", "0"]);
    } else {
        command.args(["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-alpha_bits", "16"]);
    }
    command.args(["-an"]).arg(temporary.path());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let result = command.output().map_err(|e| format!("Could not start FFmpeg: {e}. Set its full executable path in App settings."))?;
    if !result.status.success() {
        let log = String::from_utf8_lossy(&result.stderr);
        return Err(format!("FFmpeg could not encode the video: {}", log.chars().take(1600).collect::<String>()));
    }
    temporary.persist(&session.output).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn finish_encode(id: String, state: State<'_, EncodeState>) -> Result<(), String> {
    let session = state.0.lock().map_err(|e| e.to_string())?.remove(&id).ok_or("Video export session expired.")?;
    tauri::async_runtime::spawn_blocking(move || encode(session)).await.map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(EncodeState::default())
        .manage(AutomationState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // The updater requires a configured public key when it initializes.
            // Keep development builds runnable before a release repository exists.
            if app.config().plugins.0.contains_key("updater") {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![updater_configured, begin_encode, write_encode_frame, finish_encode, abort_encode, video_export_capabilities, automation_start, automation_stop, automation_status, automation_respond, automation_mcp_path])
        .run(tauri::generate_context!())
        .expect("error while running Pixel Forge");
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session(output: PathBuf, format: &str, ffmpeg: String) -> EncodeSession {
        let frames = tempfile::tempdir().unwrap();
        for index in 0..2 {
            fs::write(frames.path().join(format!("frame-{index:06}.png")), include_bytes!("../icons/32x32.png")).unwrap();
        }
        EncodeSession { frames, output, fps: 12, format: format.into(), ffmpeg, count: 2, frame_durations_ms: None, dimensions: None }
    }

    #[test]
    fn failed_encoder_preserves_existing_output() {
        let output_dir = tempfile::tempdir().unwrap();
        let output = output_dir.path().join("existing.mov");
        fs::write(&output, b"original file").unwrap();
        let job = session(output.clone(), "mov", "pixel-forge-intentionally-missing-ffmpeg".into());
        let frames = job.frames.path().to_owned();
        assert!(encode(job).is_err());
        assert_eq!(fs::read(output).unwrap(), b"original file");
        assert!(!frames.exists(), "temporary frames must be removed after failure");
    }

    #[test]
    #[ignore = "Set PIXEL_FORGE_TEST_FFMPEG and run cargo test -- --ignored to verify real codec output"]
    fn native_codecs_preserve_alpha() {
        let ffmpeg = std::env::var("PIXEL_FORGE_TEST_FFMPEG").expect("set PIXEL_FORGE_TEST_FFMPEG");
        let directory = tempfile::tempdir().unwrap();
        for format in ["mov", "webm"] {
            let output = directory.path().join(format!("alpha.{format}"));
            encode(session(output.clone(), format, ffmpeg.clone())).unwrap();
            let mut decoder = Command::new(&ffmpeg);
            decoder.args(["-hide_banner", "-loglevel", "error"]);
            if format == "webm" { decoder.args(["-c:v", "libvpx-vp9"]); }
            let result = decoder.arg("-i").arg(output).args(["-vf", "alphaextract", "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"]).output().unwrap();
            assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
            assert_eq!(result.stdout.len(), 32 * 32);
            assert!(result.stdout.iter().any(|&alpha| alpha == 0), "{format}: missing transparent alpha");
            assert!(result.stdout.iter().any(|&alpha| alpha == 255), "{format}: missing opaque alpha");
        }
    }
    #[test]
    fn timed_clock_is_exact_and_rejects_unbounded_work() {
        assert_eq!(timing_plan(&[90, 90, 90]).unwrap(), TimingPlan { tick_ms: 90, frames: 3 });
        assert_eq!(timing_plan(&[90, 170, 250]).unwrap(), TimingPlan { tick_ms: 10, frames: 51 });
        assert_eq!(timing_plan(&[83, 84, 83]).unwrap(), TimingPlan { tick_ms: 1, frames: 250 });
        assert_eq!(timing_plan(&[60_000]).unwrap(), TimingPlan { tick_ms: 60_000, frames: 1 });
        for durations in [vec![], vec![9], vec![60_001], vec![10; 1801], vec![60_000, 59_999]] {
            assert!(timing_plan(&durations).is_err());
        }
        let plan = TimingPlan { tick_ms: 1, frames: 1000 };
        assert!(validate_clock_work((1000, 512), &plan, "mov").is_ok());
        assert!(validate_clock_work((1001, 512), &plan, "mov").is_err());
        assert!(validate_clock_work((999, 511), &plan, "webm").is_ok());
        assert!(validate_clock_work((1001, 511), &plan, "webm").is_err());
    }

    #[test]
    fn explicit_ffmpeg_paths_take_precedence_over_optional_bundle() {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("bin").join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
        fs::create_dir_all(binary.parent().unwrap()).unwrap();
        let resources = Some(directory.path().to_path_buf());
        assert_eq!(resolve_ffmpeg_candidates("ffmpeg", resources.clone(), None), "ffmpeg");
        fs::write(&binary, b"test-only resolver fixture").unwrap();
        assert_eq!(resolve_ffmpeg_candidates("ffmpeg", resources.clone(), None), binary.to_string_lossy());
        assert_eq!(resolve_ffmpeg_candidates("/custom/ffmpeg", resources, None), "/custom/ffmpeg");
        assert_eq!(resolve_ffmpeg_candidates("ffmpeg", None, None), "ffmpeg");
        assert_eq!(resolve_ffmpeg_candidates("ffmpeg", None, Some(binary.clone())), binary.to_string_lossy());
        assert_eq!(resolve_ffmpeg_candidates("/custom/ffmpeg", None, Some(binary)), "/custom/ffmpeg");
    }

    #[test]
    fn failed_or_incomplete_timed_exports_preserve_existing_output() {
        let directory = tempfile::tempdir().unwrap();
        for durations in [vec![90, 170], vec![90]] {
            let output = directory.path().join("existing.mov");
            fs::write(&output, b"original file").unwrap();
            let mut job = session(output.clone(), "mov", "pixel-forge-intentionally-missing-ffmpeg".into());
            job.frame_durations_ms = Some(durations);
            let frames = job.frames.path().to_owned();
            assert!(encode(job).is_err());
            assert_eq!(fs::read(&output).unwrap(), b"original file");
            assert!(!frames.exists());
        }
    }

    fn timed_session(output: PathBuf, format: &str, ffmpeg: String, durations: Vec<u32>) -> EncodeSession {
        use std::io::Write;
        let frames = tempfile::tempdir().unwrap();
        let (width, height) = (33, 31);
        let mut raw = Vec::new();
        for index in 0..durations.len() {
            for _y in 0..height {
                for x in 0..width {
                    let mut color = [30u8, 30, 30, if x < 10 { 0 } else if x == 10 { 128 } else { 255 }];
                    color[index % 3] = 220;
                    raw.extend_from_slice(&color);
                }
            }
        }
        let mut child = Command::new(&ffmpeg).args(["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "33x31", "-framerate", "1", "-i", "pipe:0", "-start_number", "0"])
            .arg(frames.path().join("frame-%06d.png")).stdin(std::process::Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(&raw).unwrap();
        assert!(child.wait().unwrap().success());
        EncodeSession { frames, output, fps: 12, format: format.into(), ffmpeg, count: durations.len(), frame_durations_ms: Some(durations), dimensions: None }
    }

    fn probe(ffprobe: &str, path: &std::path::Path) -> serde_json::Value {
        let output = Command::new(ffprobe).args(["-v", "error", "-show_entries", "packet=pts_time,duration_time:stream=width,height:format=duration", "-of", "json"]).arg(path).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        serde_json::from_slice(&output.stdout).unwrap()
    }

    #[test]
    #[ignore = "Set PIXEL_FORGE_TEST_FFMPEG and PIXEL_FORGE_TEST_FFPROBE for real timing/alpha validation"]
    fn timed_codecs_preserve_boundaries_final_duration_and_alpha() {
        let ffmpeg = std::env::var("PIXEL_FORGE_TEST_FFMPEG").expect("set PIXEL_FORGE_TEST_FFMPEG");
        let ffprobe = std::env::var("PIXEL_FORGE_TEST_FFPROBE").expect("set PIXEL_FORGE_TEST_FFPROBE");
        let directory = tempfile::tempdir().unwrap();
        for durations in [vec![90, 90, 90], vec![90; 16], vec![90, 170, 250], vec![83, 84, 83], vec![60_000]] {
            let plan = timing_plan(&durations).unwrap();
            for format in ["mov", "webm"] {
                let path = directory.path().join(format!("timed.{format}"));
                encode(timed_session(path.clone(), format, ffmpeg.clone(), durations.clone())).unwrap();
                let metadata = probe(&ffprobe, &path);
                let packets = metadata["packets"].as_array().unwrap();
                assert_eq!(packets.len(), plan.frames as usize, "{format}: clock frame count");
                let total_ms: u32 = durations.iter().sum();
                let container_seconds: f64 = metadata["format"]["duration"].as_str().unwrap().parse().unwrap();
                assert!((container_seconds * 1000.0 - f64::from(total_ms)).abs() < 0.001, "{format}: wrong final duration {metadata}");
                for (index, packet) in packets.iter().enumerate() {
                    let pts: f64 = packet["pts_time"].as_str().unwrap().parse().unwrap();
                    assert!((pts * 1000.0 - index as f64 * f64::from(plan.tick_ms)).abs() < 0.001, "{format}: packet {index} timestamp");
                    if let Some(duration) = packet["duration_time"].as_str() {
                        let seconds: f64 = duration.parse().unwrap();
                        assert!((seconds * 1000.0 - f64::from(plan.tick_ms)).abs() < 0.001, "{format}: packet duration");
                    }
                }
                // At 1ms WebM can omit explicit packet durations; adjacent PTS and exact container
                // end still define every clock interval, including the final held frame.
                let (width, height) = if format == "webm" { (34usize, 32usize) } else { (33, 31) };
                assert_eq!(metadata["streams"][0]["width"], width);
                assert_eq!(metadata["streams"][0]["height"], height);
                let mut decoder = Command::new(&ffmpeg);
                decoder.args(["-hide_banner", "-loglevel", "error"]);
                if format == "webm" { decoder.args(["-c:v", "libvpx-vp9"]); }
                let decoded = decoder.arg("-i").arg(&path).args(["-vsync", "0", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"]).output().unwrap();
                assert!(decoded.status.success(), "{}", String::from_utf8_lossy(&decoded.stderr));
                assert_eq!(decoded.stdout.len(), width * height * 4 * packets.len());
                let mut expected_order = Vec::new();
                for (index, duration) in durations.iter().enumerate() {
                    expected_order.extend(std::iter::repeat_n(index, (duration / plan.tick_ms) as usize));
                }
                for (clock_index, (pixels, expected)) in decoded.stdout.chunks_exact(width * height * 4).zip(expected_order).enumerate() {
                    let center = (15 * width + 20) * 4;
                    assert!(pixels[center + expected % 3] > 180, "{format}: wrong frame at clock {clock_index}, source {expected}, durations {durations:?}, pixel {:?}", &pixels[center..center+4]);
                    assert_eq!(pixels[(15 * width + 5) * 4 + 3], 0, "{format}: transparency lost");
                    assert_eq!(pixels[center + 3], 255, "{format}: opaque alpha lost");
                    assert!((i16::from(pixels[(15 * width + 10) * 4 + 3]) - 128).abs() <= 3, "{format}: partial alpha lost");
                    if format == "webm" {
                        assert_eq!(pixels[(15 * width + 33) * 4 + 3], 0, "odd width padding must be transparent");
                        assert_eq!(pixels[(31 * width + 20) * 4 + 3], 0, "odd height padding must be transparent");
                    }
                }
            }
        }
        for format in ["mov", "webm"] {
            let path = directory.path().join(format!("legacy.{format}"));
            encode(session(path.clone(), format, ffmpeg.clone())).unwrap();
            let metadata = probe(&ffprobe, &path);
            assert_eq!(metadata["packets"].as_array().unwrap().len(), 2);
            let seconds: f64 = metadata["format"]["duration"].as_str().unwrap().parse().unwrap();
            assert!((seconds - 2.0 / 12.0).abs() < 0.001, "legacy constant FPS changed");
        }
    }

    /// Local, user-supplied integration fixture. The manifest is JSON with ordered
    /// `frames: [{file: "relative/path.png", durationMs: 90}]`. Inputs are only read;
    /// PIXEL_FORGE_TEST_VIDEO_OUTPUT must name a new directory so nothing is overwritten.
    #[test]
    #[ignore = "Set FRAME_MANIFEST, VIDEO_OUTPUT, FFMPEG and FFPROBE PIXEL_FORGE_TEST_* variables"]
    fn exported_png_fixture_encodes_to_timed_alpha_video() {
        let manifest_path = PathBuf::from(std::env::var("PIXEL_FORGE_TEST_FRAME_MANIFEST").expect("set PIXEL_FORGE_TEST_FRAME_MANIFEST"));
        let output_dir = PathBuf::from(std::env::var("PIXEL_FORGE_TEST_VIDEO_OUTPUT").expect("set PIXEL_FORGE_TEST_VIDEO_OUTPUT to a new directory"));
        let ffmpeg = std::env::var("PIXEL_FORGE_TEST_FFMPEG").expect("set PIXEL_FORGE_TEST_FFMPEG");
        let ffprobe = std::env::var("PIXEL_FORGE_TEST_FFPROBE").expect("set PIXEL_FORGE_TEST_FFPROBE");
        assert!(manifest_path.is_absolute() && output_dir.is_absolute());
        let manifest: serde_json::Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        let entries = manifest["frames"].as_array().expect("manifest.frames must be an array");
        let durations: Vec<u32> = entries.iter().map(|frame| u32::try_from(frame["durationMs"].as_u64().expect("whole durationMs")).unwrap()).collect();
        let plan = timing_plan(&durations).unwrap();
        let sources: Vec<PathBuf> = entries.iter().map(|frame| manifest_path.parent().unwrap().join(frame["file"].as_str().expect("frame.file"))).collect();
        let (width, height) = png_dimensions(&fs::read(&sources[0]).unwrap()).unwrap();
        for format in ["mov", "webm"] { validate_clock_work((width, height), &plan, format).unwrap(); }
        fs::create_dir(&output_dir).expect("output directory must not exist; select a new path");
        let mut source_pixels = Vec::new();
        for source in &sources {
            assert_eq!(png_dimensions(&fs::read(source).unwrap()).unwrap(), (width, height));
            let decoded = Command::new(&ffmpeg).args(["-hide_banner", "-loglevel", "error", "-i"]).arg(source)
                .args(["-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"]).output().unwrap();
            assert!(decoded.status.success(), "{}", String::from_utf8_lossy(&decoded.stderr));
            assert_eq!(decoded.stdout.len(), width as usize * height as usize * 4);
            source_pixels.push(decoded.stdout);
        }
        let source_alpha = |condition: fn(u8) -> bool| source_pixels.iter().flat_map(|frame| frame.chunks_exact(4)).filter(|pixel| condition(pixel[3])).count();
        let transparent_pixels = source_alpha(|alpha| alpha == 0);
        let soft_pixels = source_alpha(|alpha| alpha > 0 && alpha < 255);
        assert!(transparent_pixels > 0, "fixture must contain transparent pixels");
        assert!(soft_pixels > 0, "fixture must contain soft alpha to test chroma-key preservation");
        let total_ms: u32 = durations.iter().sum();
        let mut evidence = Vec::new();
        for format in ["mov", "webm"] {
            let path = output_dir.join(format!("keyed-animation.{format}"));
            let frames = tempfile::tempdir().unwrap();
            for (index, source) in sources.iter().enumerate() {
                fs::copy(source, frames.path().join(format!("frame-{index:06}.png"))).unwrap();
            }
            encode(EncodeSession { frames, output: path.clone(), fps: 12, format: format.into(), ffmpeg: ffmpeg.clone(), count: sources.len(), frame_durations_ms: Some(durations.clone()), dimensions: Some((width, height)) }).unwrap();
            let metadata = probe(&ffprobe, &path);
            let packets = metadata["packets"].as_array().unwrap();
            assert_eq!(packets.len(), plan.frames as usize);
            let seconds: f64 = metadata["format"]["duration"].as_str().unwrap().parse().unwrap();
            assert!((seconds * 1000.0 - f64::from(total_ms)).abs() < 0.001);
            for (index, packet) in packets.iter().enumerate() {
                let pts: f64 = packet["pts_time"].as_str().unwrap().parse().unwrap();
                assert!((pts * 1000.0 - index as f64 * f64::from(plan.tick_ms)).abs() < 0.001);
            }
            let out_width = width as usize + if format == "webm" { width as usize % 2 } else { 0 };
            let out_height = height as usize + if format == "webm" { height as usize % 2 } else { 0 };
            assert_eq!(metadata["streams"][0]["width"], out_width);
            assert_eq!(metadata["streams"][0]["height"], out_height);
            let mut decoder = Command::new(&ffmpeg);
            decoder.args(["-hide_banner", "-loglevel", "error"]);
            if format == "webm" { decoder.args(["-c:v", "libvpx-vp9"]); }
            let decoded = decoder.arg("-i").arg(&path).args(["-vsync", "0", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"]).output().unwrap();
            assert!(decoded.status.success(), "{}", String::from_utf8_lossy(&decoded.stderr));
            assert_eq!(decoded.stdout.len(), out_width * out_height * 4 * packets.len());
            let expected_order: Vec<usize> = durations.iter().enumerate().flat_map(|(index, duration)| std::iter::repeat_n(index, (duration / plan.tick_ms) as usize)).collect();
            let mut max_alpha_error = 0u8;
            let mut max_mean_color_error = 0.0f64;
            for (clock, (pixels, expected)) in decoded.stdout.chunks_exact(out_width * out_height * 4).zip(expected_order).enumerate() {
                let source = &source_pixels[expected];
                for y in 0..out_height {
                    for x in 0..out_width {
                        let alpha = pixels[(y * out_width + x) * 4 + 3];
                        if x >= width as usize || y >= height as usize { assert_eq!(alpha, 0, "padding must be transparent"); }
                        else { max_alpha_error = max_alpha_error.max(alpha.abs_diff(source[(y * width as usize + x) * 4 + 3])); }
                    }
                }
                // Match every decoded clock frame against the ordered PNGs, ignoring RGB
                // under alpha=0. This catches correct packet timestamps with shifted content.
                let color_error = |candidate: &[u8]| {
                    let mut error = 0u64;
                    let mut weight = 0u64;
                    for y in 0..height as usize {
                        for x in 0..width as usize {
                            let input = (y * width as usize + x) * 4;
                            let output = (y * out_width + x) * 4;
                            let alpha = u64::from(candidate[input + 3]);
                            for channel in 0..3 { error += u64::from(candidate[input + channel].abs_diff(pixels[output + channel])) * alpha; }
                            error += u64::from(candidate[input + 3].abs_diff(pixels[output + 3])) * 255;
                            weight += 3 * alpha + 255;
                        }
                    }
                    error as f64 / weight.max(1) as f64
                };
                let expected_error = color_error(source);
                let best_error = source_pixels.iter().map(|candidate| color_error(candidate)).fold(f64::INFINITY, f64::min);
                assert!(expected_error <= best_error + 0.1, "{format}: wrong image at clock {clock}, expected source {expected}");
                assert!(expected_error < 15.0, "{format}: unexpected color loss {expected_error}");
                max_mean_color_error = max_mean_color_error.max(expected_error);
            }
            assert!(max_alpha_error <= 3, "{format}: alpha changed by {max_alpha_error}");
            evidence.push(serde_json::json!({"file":path.file_name().unwrap().to_str().unwrap(),"width":out_width,"height":out_height,"durationMs":total_ms,"clockTickMs":plan.tick_ms,"encodedFrames":plan.frames,"sourceFrames":sources.len(),"sourceSoftAlphaPixels":soft_pixels,"sourceTransparentPixels":transparent_pixels,"maxAlphaError":max_alpha_error,"maxMeanColorError":max_mean_color_error,"allFrameBoundariesVerified":true,"probe":metadata}));
        }
        fs::write(output_dir.join("verification.json"), serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
        println!("Verified MOV and WebM saved to {}", output_dir.display());
    }

}
