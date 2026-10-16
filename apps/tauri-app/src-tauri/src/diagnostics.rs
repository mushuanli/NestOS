use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

static LOG: OnceLock<DiagnosticLog> = OnceLock::new();
struct DiagnosticLog {
    path: PathBuf,
    marker: PathBuf,
    lock: Mutex<()>,
}

fn stamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn append(path: &Path, event: &str, detail: Value, durable: bool) -> std::io::Result<()> {
    if std::fs::metadata(path)
        .map(|m| m.len() > 4 * 1024 * 1024)
        .unwrap_or(false)
    {
        let _ = std::fs::rename(path, path.with_extension("previous.jsonl"));
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    // Formatting Value directly streams many writes, interleaving concurrent emergency records.
    let mut line = serde_json::to_vec(
        &json!({"timeMs": stamp(), "pid": std::process::id(), "event": event, "detail": detail}),
    )?;
    line.push(b'\n');
    file.write_all(&line)?;
    if durable {
        file.sync_data()?;
    }
    Ok(())
}

pub fn record(event: &str, detail: Value) {
    record_inner(event, detail, false);
}

pub(crate) fn record_durable(event: &str, detail: Value) {
    record_inner(event, detail, true);
}

fn record_inner(event: &str, detail: Value, durable: bool) {
    if let Some(log) = LOG.get() {
        if let Ok(_guard) = log.lock.try_lock() {
            if let Err(error) = append(&log.path, event, detail, durable) {
                eprintln!("[Diagnostics] {error}");
            }
        } else {
            let _ = append(
                &log.path.with_extension("emergency.jsonl"),
                event,
                detail,
                durable,
            );
        }
    }
}

pub fn install() {
    let base = std::env::var_os("MINDOS_DIAGNOSTICS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config")
                })
                .join("mindos/logs/desktop")
        });
    if let Err(error) = std::fs::create_dir_all(&base) {
        eprintln!("[Diagnostics] Cannot create {}: {error}", base.display());
        return;
    }
    recover_markers(&base);
    let mode = if cfg!(debug_assertions) { "dev" } else { "release" };
    let id = format!("tauri-{mode}-{}-{}", stamp(), std::process::id());
    let path = base.join(format!("{id}.jsonl"));
    let marker = base.join(format!("{id}.active"));
    let _ = std::fs::write(&marker, std::process::id().to_string());
    eprintln!("[Diagnostics] {}", path.display());
    let _ = LOG.set(DiagnosticLog {
        path,
        marker,
        lock: Mutex::new(()),
    });
    record(
        "process.start",
        json!({"cwd": std::env::current_dir().ok(), "version": env!("CARGO_PKG_VERSION")}),
    );
    install_panic_hook();
    spawn_watcher();
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        record_durable(
            "rust.panic",
            json!({"message": info.to_string(), "backtrace": std::backtrace::Backtrace::force_capture().to_string()}),
        );
        previous(info);
    }));
}

pub fn clean_exit() {
    record_durable("process.exit", json!({"clean": true}));
    if let Some(log) = LOG.get() {
        let _ = std::fs::remove_file(&log.marker);
    }
}

fn recover_markers(base: &Path) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("active") {
            continue;
        }
        let pid = std::fs::read_to_string(&path)
            .ok()
            .and_then(|v| v.parse::<u32>().ok());
        // Liveness needs /proc, so unclean-exit recovery only runs where it is reliable.
        #[cfg(target_os = "linux")]
        {
            if pid.is_some_and(process_alive) {
                continue;
            }
            let _ = append(
                &path.with_extension("jsonl"),
                "process.previous_unclean_exit",
                json!({"pid": pid, "reason": "unknown; inspect OS OOM/coredump logs"}),
                true,
            );
            let _ = std::fs::remove_file(path);
        }
        #[cfg(not(target_os = "linux"))]
        {
            // Without /proc a live pid cannot be told apart from a recycled one; keep the marker.
            let _ = pid;
        }
    }
}

fn spawn_watcher() {
    #[cfg(target_os = "linux")]
    if let (Some(log), Ok(exe)) = (LOG.get(), std::env::current_exe()) {
        use std::process::{Command, Stdio};
        let result = Command::new(exe)
            .arg("--mindos-diagnostic-watch")
            .arg(std::process::id().to_string())
            .arg(&log.marker)
            .arg(&log.path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let Err(error) = result {
            record_durable("watcher.failed", json!({"error": error.to_string()}));
        }
    }
}

/// A separate process can record SIGKILL/OOM disappearance after the app can no longer write.
pub fn run_watcher() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--mindos-diagnostic-watch") {
        return false;
    }
    if args.len() != 5 || args[2].parse::<u32>().is_err() {
        return true;
    }
    let marker = Path::new(&args[3]);
    while marker.exists() && process_alive(args[2].parse().unwrap()) {
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    if marker.exists() {
        let _ = append(
            Path::new(&args[4]),
            "process.unexpected_exit",
            json!({"pid": args[2], "reason": "unknown; no clean exit observed"}),
            true,
        );
        let _ = std::fs::remove_file(marker);
    }
    true
}

fn process_alive(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|text| {
            text.rsplit_once(") ")
                .map(|(_, fields)| !fields.starts_with('Z'))
        })
        .unwrap_or(false)
}

#[tauri::command]
pub fn diagnostic_log_path() -> Option<String> {
    LOG.get().map(|log| log.path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn diagnostic_event(event: String, message: String) -> Result<(), String> {
    if event.len() > 80 || message.len() > 16_384 {
        return Err("Diagnostic event exceeds limit".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let name = format!("frontend.{event}");
        let detail = json!({"message": message});
        if is_failure_event(&event) {
            record_durable(&name, detail);
        } else {
            record(&name, detail);
        }
    })
    .await
    .map_err(|error| error.to_string())
}

fn is_failure_event(event: &str) -> bool {
    let event = event.to_ascii_lowercase();
    event.contains("error")
        || event.contains("exception")
        || event.contains("rejection")
        || event.ends_with(".failed")
        || event == "failed"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn syncs_failures_but_not_routine_progress_events() {
        for event in [
            "bootstrap.failed",
            "window.error",
            "unhandledrejection",
            "tool.exception",
        ] {
            assert!(is_failure_event(event), "{event}");
        }
        for event in [
            "bootstrap.stage",
            "bootstrap.source.ready",
            "session.load.ready",
        ] {
            assert!(!is_failure_event(event), "{event}");
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn detects_stale_markers_without_marking_a_live_process_as_crashed() {
        let root = std::env::temp_dir().join(format!("desktop-marker-test-{}", stamp()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("dead.active"), "4294967295").unwrap();
        std::fs::write(root.join("alive.active"), std::process::id().to_string()).unwrap();
        recover_markers(&root);
        assert!(!root.join("dead.active").exists());
        assert!(root.join("alive.active").exists());
        let text = std::fs::read_to_string(root.join("dead.jsonl")).unwrap();
        assert!(text.contains("process.previous_unclean_exit"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn concurrent_emergency_records_remain_complete_json_lines() {
        let root = std::env::temp_dir().join(format!("desktop-concurrent-log-{}", stamp()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("emergency.jsonl");
        std::thread::scope(|scope| {
            for worker in 0..8 {
                let path = &path;
                scope.spawn(move || {
                    for index in 0..8 {
                        append(
                            path,
                            "bootstrap.source.ready",
                            json!({"worker": worker, "index": index, "message": "x".repeat(4000)}),
                            false,
                        )
                        .unwrap();
                    }
                });
            }
        });
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().count(), 64);
        for line in text.lines() {
            serde_json::from_str::<Value>(line).unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn appends_parseable_diagnostics_and_rotates_large_logs() {
        let root = std::env::temp_dir().join(format!("desktop-log-test-{}", stamp()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("run.jsonl");
        append(
            &path,
            "rust.panic",
            json!({"message": "line one\nline two"}),
            true,
        )
        .unwrap();
        let row: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(row["event"], "rust.panic");
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(4 * 1024 * 1024 + 1)
            .unwrap();
        append(&path, "process.exit", json!({}), true).unwrap();
        assert!(path.with_extension("previous.jsonl").exists());
        assert!(std::fs::metadata(&path).unwrap().len() < 1024);
        std::fs::remove_dir_all(root).unwrap();
    }
}
