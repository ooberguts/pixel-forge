use std::{collections::HashMap, fs, path::PathBuf, process::Command, sync::Mutex};
use tauri::State;
use tempfile::{NamedTempFile, TempDir};

struct EncodeSession {
    frames: TempDir,
    output: PathBuf,
    fps: u32,
    format: String,
    ffmpeg: String,
    count: usize,
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

#[tauri::command]
fn begin_encode(output: String, fps: u32, format: String, ffmpeg: String, state: State<'_, EncodeState>) -> Result<String, String> {
    if fps == 0 || fps > 60 || !["webm", "mov"].contains(&format.as_str()) {
        return Err("Invalid video format or frame rate.".into());
    }
    let path = PathBuf::from(&output);
    if !path.is_absolute() || path.extension().and_then(|s| s.to_str()) != Some(format.as_str()) {
        return Err("Select an absolute output path with the correct extension.".into());
    }
    if ffmpeg.trim().is_empty() {
        return Err("Set the FFmpeg executable path in App settings.".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let session = EncodeSession {
        frames: tempfile::Builder::new().prefix("pixel-forge-").tempdir().map_err(|e| e.to_string())?,
        output: path, fps, format, ffmpeg, count: 0,
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
    let parent = session.output.parent().ok_or("Invalid output directory.")?;
    // Encode to our own temporary output. A failed encode never replaces the user's file.
    let temporary: NamedTempFile = tempfile::Builder::new().prefix(".pixel-forge-")
        .suffix(&format!(".{}", session.format)).tempfile_in(parent).map_err(|e| e.to_string())?;
    let mut command = Command::new(&session.ffmpeg);
    command.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-framerate", &session.fps.to_string(), "-i"])
        .arg(session.frames.path().join("frame-%06d.png"));
    if session.format == "webm" {
        command.args(["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2:color=black@0", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-lossless", "1", "-auto-alt-ref", "0"]);
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
        .invoke_handler(tauri::generate_handler![updater_configured, begin_encode, write_encode_frame, finish_encode, abort_encode])
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
        EncodeSession { frames, output, fps: 12, format: format.into(), ffmpeg, count: 2 }
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
}
