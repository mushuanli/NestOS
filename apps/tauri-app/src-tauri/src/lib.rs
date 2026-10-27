mod mcp_process;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_fs::FsExt;
mod atomic_file;
mod profile_config;
mod sidecar;
mod directory_boundary;
mod scoped_fs;
mod fs_commands;
mod scoped_directory;
pub mod diagnostics;

// ── Settings ──────────────────────────────────────────────────────────────────


struct NestosSettings {
    /// Raw value from nestos.json#rootDir — may be relative or absolute.
    root_dir: Option<PathBuf>,
    home_dir: Option<PathBuf>,
}

fn read_settings(config_dir: &PathBuf) -> NestosSettings {
    let Ok(raw) = std::fs::read_to_string(profile_config::settings_file(config_dir)) else {
        return NestosSettings { root_dir: None, home_dir: None };
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return NestosSettings { root_dir: None, home_dir: None };
    };
    NestosSettings {
        root_dir: v["rootDir"].as_str().filter(|s| !s.is_empty()).map(PathBuf::from),
        home_dir: v["homeDir"].as_str().filter(|s| !s.is_empty()).map(PathBuf::from),
    }
}

// ── Path resolution ────────────────────────────────────────────────────────────

#[derive(Clone)]
pub(crate) struct AppPaths {
    /// Config dir: $XDG_CONFIG_HOME/nestos or ~/.config/nestos. nestos.json lives here.
    /// Deliberately separate from the data root — ~/.nestos may hold unrelated
    /// data, so it is never used as a default location.
    config_dir: PathBuf,
    /// Resolved data root. All VFS modules live here (module/, _db/, _meta/).
    /// From NESTOS_ROOT env, nestos.json#rootDir, or <config_dir>/data.
    root_dir: PathBuf,
    home_dir: PathBuf,
    /// Which input produced `root_dir`, surfaced at startup and in diagnostics.
    root_source: RootSource,
    /// Which input produced `home_dir`, surfaced at startup and in diagnostics.
    home_source: HomeSource,
}

/// Origin of the resolved data root — keeps startup logs self-explanatory.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum RootSource {
    Env,
    Settings,
    Default,
}

impl RootSource {
    fn label(self) -> &'static str {
        match self {
            RootSource::Env => "NESTOS_ROOT env",
            RootSource::Settings => "nestos.json#rootDir",
            RootSource::Default => "<config_dir>/data (default)",
        }
    }
}

/// Origin of the resolved workspace directory (mounted at `/workspace`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum HomeSource {
    CliArg,
    Settings,
    InitCwd,
    ProcessCwd,
}

impl HomeSource {
    fn label(self) -> &'static str {
        match self {
            HomeSource::CliArg => "--home arg",
            HomeSource::Settings => "nestos.json#homeDir",
            HomeSource::InitCwd => "INIT_CWD (launch dir)",
            HomeSource::ProcessCwd => "process cwd (fallback)",
        }
    }
}

#[derive(Default)]
struct ShellProcesses(Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);

struct CodexProcess {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
}

#[derive(Default)]
struct CodexAppServer(Mutex<Option<CodexProcess>>);

fn resolve_all_paths(system_home: &PathBuf) -> std::io::Result<AppPaths> {
    // Config lives at $XDG_CONFIG_HOME/nestos/nestos.json (default ~/.config/nestos),
    // never inside the data root. This keeps unrelated ~/.nestos data untouched.
    let xdg = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let config_dir = profile_config::config_dir(system_home, xdg);
    profile_config::ensure_settings(&config_dir)?;

    let NestosSettings { root_dir: settings_root, home_dir: settings_home } = read_settings(&config_dir);

    // Data root resolution order:
    //   NESTOS_ROOT env      → explicit override, used as-is
    //   nestos.json#rootDir → primary source; relative resolved against config_dir
    //   default              → <config_dir>/data (never ~/.nestos)
    let env_root = std::env::var("NESTOS_ROOT").or_else(|_| std::env::var("MINDOS_ROOT")).ok().filter(|s| !s.is_empty());
    let (root_dir, root_source) = match (env_root, settings_root) {
        (Some(raw), _) => (PathBuf::from(raw), RootSource::Env),
        (None, Some(rd)) => (
            if rd.is_absolute() { rd } else { normalize_path(&config_dir.join(&rd)) },
            RootSource::Settings,
        ),
        (None, None) => (config_dir.join("data"), RootSource::Default),
    };

    let (home_dir, home_source) = resolve_home_dir(settings_home);

    Ok(AppPaths { config_dir, root_dir, home_dir, root_source, home_source })
}

/// Resolve the host workspace directory (mounted at `/workspace`).
///
/// `--home` wins, then nestos.json#homeDir, then `INIT_CWD` — the directory the
/// user launched from, which npm/pnpm export because `tauri dev` runs the app
/// with `src-tauri/` as its process cwd — and only then the process cwd.
fn resolve_home_dir(settings_home: Option<PathBuf>) -> (PathBuf, HomeSource) {
    if let Some(path) = resolve_home_from_cli() {
        return (path, HomeSource::CliArg);
    }
    if let Some(path) = settings_home {
        return (path, HomeSource::Settings);
    }
    if let Some(path) = init_cwd() {
        return (path, HomeSource::InitCwd);
    }
    (
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        HomeSource::ProcessCwd,
    )
}

/// Launch directory exported by npm/pnpm, when it still exists.
fn init_cwd() -> Option<PathBuf> {
    let raw = std::env::var("INIT_CWD").ok().filter(|value| !value.is_empty())?;
    let path = PathBuf::from(raw);
    path.is_dir().then_some(path)
}

/// Report the resolved paths on the launching terminal, so the active data root
/// and where it came from are visible without opening the webview console.
fn log_resolved_paths(paths: &AppPaths) {
    let config_file = profile_config::settings_file(&paths.config_dir);
    println!("[NestOS] config file : {}", config_file.display());
    println!("[NestOS] data root   : {}  ({})", paths.root_dir.display(), paths.root_source.label());
    println!("[NestOS] workspace   : {}  ({})", paths.home_dir.display(), paths.home_source.label());
    diagnostics::record("paths.resolved", serde_json::json!({
        "configFile": config_file.to_string_lossy(),
        "dataRoot": paths.root_dir.to_string_lossy(),
        "homeDir": paths.home_dir.to_string_lossy(),
        "rootSource": paths.root_source.label(),
        "homeSource": paths.home_source.label(),
    }));
}

fn resolve_home_from_cli() -> Option<PathBuf> {
    let args: Vec<String> = std::env::args().collect();
    if let Some(idx) = args.iter().position(|a| a == "--home") {
        if let Some(p) = args.get(idx + 1).filter(|p| !p.starts_with('-')) {
            return Some(PathBuf::from(canonicalise(p)));
        }
    }
    for arg in args.iter().skip(1) {
        if !arg.starts_with('-') {
            let p = PathBuf::from(arg);
            if p.is_dir() {
                return Some(PathBuf::from(canonicalise(arg)));
            }
        }
    }
    None
}

/// Normalize a path (resolve `..` and `.`) without requiring it to exist.
/// Prevents directory traversal: `/allowed/dir/../../../etc/passwd` → `/etc/passwd`.
fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => { out.pop(); }
            Component::CurDir    => {}
            other                => out.push(other),
        }
    }
    out
}

pub(crate) fn is_allowed(path: &Path, paths: &AppPaths) -> bool {
    let norm = normalize_path(path);
    norm.starts_with(&paths.root_dir) || norm.starts_with(&paths.home_dir)
}

// ── Other commands ─────────────────────────────────────────────────────────────

#[tauri::command]
fn get_home_dir(paths: State<AppPaths>) -> String {
    paths.home_dir.to_string_lossy().into_owned()
}

/// Resolved VFS root directory (base for all module data).
/// From NESTOS_ROOT env, nestos.json#rootDir, or <config_dir>/data.
/// Relative rootDir values are resolved against the config dir
/// (~/.config/nestos), keeping the data root portable.
#[tauri::command]
fn get_root_dir(paths: State<AppPaths>) -> String {
    paths.root_dir.to_string_lossy().into_owned()
}

/// Where the resolved root and workspace came from, e.g. `nestos.json#rootDir`.
#[derive(serde::Serialize)]
struct PathSources {
    root: String,
    home: String,
}

#[tauri::command]
fn get_path_sources(paths: State<AppPaths>) -> PathSources {
    PathSources {
        root: paths.root_source.label().to_string(),
        home: paths.home_source.label().to_string(),
    }
}

#[tauri::command]
fn get_current_dir() -> Result<String, String> {
    std::env::current_dir().map(|path| path.to_string_lossy().into_owned()).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_app_data_dir(app: AppHandle) -> String {
    app.path().app_local_data_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".tauri-data".to_string())
}

#[tauri::command]
fn get_app_config_dir(app: AppHandle) -> String {
    app.path().app_config_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".tauri-config".to_string())
}

// ── Native search commands (rg / fd) ──────────────────────────────────────────
//
// These commands expose ripgrep and fd to the Tauri webview, enabling
// INativeShell-backed tools (GrepTool, GlobTool, BashTool) to use native
// binaries instead of manual JS/VFS walking.
//
// Security: all `dir` parameters are validated against is_allowed() before
// passing to the subprocess — same policy as the fs_* commands.
// The spawned commands are limited to rg/fd binaries; no general shell exec.

/// Capabilities advertised to the TS side at startup.
#[derive(serde::Serialize)]
pub struct NativeCapabilities {
    ripgrep: bool,
    fd:      bool,
}

fn which(cmd: &str) -> bool {
    std::process::Command::new(cmd)
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Return which native search tools are available.
#[tauri::command]
fn native_capabilities() -> NativeCapabilities {
    NativeCapabilities { ripgrep: which("rg"), fd: which("fd") }
}

/// Run ripgrep and return its raw stdout (JSONL format).
/// The TS layer (TauriNativeShell) parses the JSONL.
#[tauri::command]
fn search_ripgrep(
    pattern:     String,
    dir:         String,
    glob:        Option<String>,
    max_results: Option<u32>,
    state:       State<AppPaths>,
) -> Result<String, String> {
    let p = PathBuf::from(&dir);
    if !is_allowed(&p, &state) { return Err(format!("path not allowed: {dir}")); }

    let limit = max_results.unwrap_or(50).to_string();
    let exclude_glob = "!{node_modules,dist,.git,.svn,build,out,.next,.nuxt,.cache,coverage,__pycache__}/**";

    let mut cmd = std::process::Command::new("rg");
    cmd.arg("--json")
       .arg("--case-insensitive")
       .arg("--glob").arg(exclude_glob)
       .arg("--max-filesize").arg("1M")
       .arg("--max-count").arg(&limit);

    if let Some(g) = &glob {
        cmd.arg("--glob").arg(g);
    }
    cmd.arg("-e").arg(&pattern).arg(&dir);

    let out = cmd.output().map_err(|e| format!("rg exec failed: {e}"))?;
    // rg exits 1 when no matches found (not an error for us)
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Run fd and return its raw stdout (one path per line).
#[tauri::command]
fn search_fd(
    pattern:     String,
    dir:         String,
    max_results: Option<u32>,
    state:       State<AppPaths>,
) -> Result<String, String> {
    let p = PathBuf::from(&dir);
    if !is_allowed(&p, &state) { return Err(format!("path not allowed: {dir}")); }

    let limit = max_results.unwrap_or(100).to_string();

    let out = std::process::Command::new("fd")
        .arg("--type").arg("f")
        .arg("--max-results").arg(&limit)
        .arg("--exclude").arg("node_modules")
        .arg("--exclude").arg("dist")
        .arg("--exclude").arg(".git")
        .arg("--exclude").arg(".svn")
        .arg("--exclude").arg("build")
        .arg("--exclude").arg("out")
        .arg("--exclude").arg(".next")
        .arg("--exclude").arg(".nuxt")
        .arg("--exclude").arg(".cache")
        .arg("--exclude").arg("coverage")
        .arg("--exclude").arg("__pycache__")
        .arg("--glob").arg(&pattern)
        .arg(&dir)
        .output()
        .map_err(|e| format!("fd exec failed: {e}"))?;

    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

mod bash_process;
mod session_bash;
mod host_git;

/// Run a whitelisted git command inside a repository root (isolated Flow workspaces).
///
/// Uses an existing directory capability, exact argv shapes and a cleared environment.
/// System/global config and hooks are disabled; local repository config still needs review.
#[tauri::command]
async fn git_command(repository_id: String, args: Vec<String>, timeout_ms: Option<u64>,
    workspace_id: Option<String>,
    directories: State<'_, scoped_fs::DirectoryScopes>) -> Result<(String, String, i32), String> {
    host_git::run_scoped(&repository_id, &args, timeout_ms, &directories, workspace_id.as_deref())
}

#[derive(Clone, serde::Serialize)]
struct ShellOutput { stream: &'static str, data: Vec<u8> }

/// Execute Bash after validating the host working directory.
/// This host command alone does not enforce Session mount grants.
#[tauri::command]
async fn shell_exec(
    command: String,
    cwd:     String,
    timeout_ms: Option<u64>,
    request_id: String,
    state:   State<'_, AppPaths>,
    processes: State<'_, ShellProcesses>,
    on_output: Option<tauri::ipc::JavaScriptChannelId>, webview: tauri::Webview,
) -> Result<(String, String, i32), String> {
    let p = PathBuf::from(&cwd);
    if !is_allowed(&p, &state) { return Err(format!("cwd not allowed: {cwd}")); }

    run_shell(bash_process::command(&command, &cwd), timeout_ms.unwrap_or(30_000), request_id, processes.0.clone(), on_output.map(|id| id.channel_on(webview))).await
}

#[tauri::command]
async fn session_shell_exec(command: String, cwd: String, timeout_ms: Option<u64>, request_id: String,
    mounts: Vec<(String, String, bool)>, directories: State<'_, scoped_fs::DirectoryScopes>,
    processes: State<'_, ShellProcesses>, on_output: Option<tauri::ipc::JavaScriptChannelId>, webview: tauri::Webview) -> Result<(String, String, i32), String> {
    let grants = {
        let scopes = directories.0.lock().map_err(|_| "directory lock poisoned")?;
        mounts.into_iter().map(|(id, target, writable)| {
            let source = scopes.get(&id).ok_or("Session directory handle closed")?;
            Ok(session_bash::Mount { source: source.to_string_lossy().into_owned(), target, writable })
        }).collect::<Result<Vec<_>, String>>()?
    };
    run_shell(session_bash::command(&command, &cwd, &grants)?, timeout_ms.unwrap_or(30_000), request_id, processes.0.clone(), on_output.map(|id| id.channel_on(webview))).await
}

async fn run_shell(command: Command, timeout_ms: u64, request_id: String,
    registry: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>, on_output: Option<tauri::ipc::Channel<ShellOutput>>) -> Result<(String, String, i32), String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut entries = registry.lock().map_err(|_| "shell process lock poisoned")?;
        if entries.contains_key(&request_id) { return Err("Duplicate shell requestId".into()); }
        entries.insert(request_id.clone(), cancelled.clone());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let output = on_output.map(|channel| Arc::new(move |stream, data: &[u8]| {
            let _ = channel.send(ShellOutput { stream, data: data.to_vec() });
        }) as bash_process::OutputSink);
        let result = bash_process::execute_streamed(command, timeout_ms, &cancelled, output);
        registry.lock().map_err(|_| "shell process lock poisoned")?.remove(&request_id);
        result
    }).await.map_err(|e| format!("Bash worker failed: {e}"))?
}

#[tauri::command]
fn shell_cancel(request_id: String, processes: State<ShellProcesses>) -> Result<(), String> {
    if let Some(cancelled) = processes.0.lock().map_err(|_| "shell process lock poisoned")?.get(&request_id) {
        cancelled.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// Start one persistent Codex app-server for the webview.
#[tauri::command]
fn codex_start(cwd: String, paths: State<AppPaths>, server: State<CodexAppServer>) -> Result<(), String> {
    let path = PathBuf::from(&cwd);
    if !is_allowed(&path, &paths) { return Err(format!("cwd not allowed: {cwd}")); }
    let mut slot = server.0.lock().map_err(|_| "codex process lock poisoned")?;
    if slot.is_some() { return Ok(()); }
    let mut child = Command::new("codex")
        .args(["app-server", "--listen", "stdio://"])
        .current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|e| format!("codex app-server failed: {e}"))?;
    let stdin = child.stdin.take().ok_or("codex stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("codex stdout unavailable")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() { break; }
        }
    });
    *slot = Some(CodexProcess { child, stdin, lines: rx });
    Ok(())
}

#[tauri::command]
fn codex_send(message: String, server: State<CodexAppServer>) -> Result<(), String> {
    let mut slot = server.0.lock().map_err(|_| "codex process lock poisoned")?;
    let process = slot.as_mut().ok_or("codex app-server is not running")?;
    writeln!(process.stdin, "{message}").and_then(|_| process.stdin.flush())
        .map_err(|e| format!("codex write failed: {e}"))
}

#[tauri::command]
fn codex_poll(server: State<CodexAppServer>) -> Result<Vec<String>, String> {
    let slot = server.0.lock().map_err(|_| "codex process lock poisoned")?;
    let process = slot.as_ref().ok_or("codex app-server is not running")?;
    let mut lines = Vec::new();
    while lines.len() < 100 {
        match process.lines.try_recv() { Ok(line) => lines.push(line), Err(_) => break }
    }
    Ok(lines)
}

#[tauri::command]
fn codex_stop(server: State<CodexAppServer>) -> Result<(), String> {
    if let Some(mut process) = server.0.lock().map_err(|_| "codex process lock poisoned")?.take() {
        let _ = process.child.kill();
        let _ = process.child.wait();
    }
    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn canonicalise(raw: &str) -> String {
    std::fs::canonicalize(raw)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| raw.to_string())
}

// ── Entry point ────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    diagnostics::install();
    let app = tauri::Builder::default()
        .manage(mcp_process::MCPProcesses::default())
        .setup(|app| {
            let system_home = app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."));
            let paths = resolve_all_paths(&system_home)?;
            log_resolved_paths(&paths);

            let _ = std::fs::create_dir_all(&paths.config_dir);
            for sub in &["", "_meta", "_db", "meta", "home/admin", "var/lib", "etc", "run"] {
                let _ = std::fs::create_dir_all(paths.root_dir.join(sub));
            }
            for module in &[
                "etc", "chats", "agents",
                "prompts", "projects", "emails", "private",
            ] {
                let _ = std::fs::create_dir_all(paths.root_dir.join("_db").join(module));
            }

            // Keep plugin-fs scope for any direct plugin-fs usage elsewhere.
            // Our TauriFsOps now uses Rust commands (fs_*) instead, so these
            // scope entries are only a fallback / belt-and-suspenders.
            let _ = app.fs_scope().allow_directory(&paths.home_dir, true);
            let _ = app.fs_scope().allow_directory(&paths.root_dir, true);

            app.manage(paths);
            app.manage(scoped_fs::DirectoryScopes::default());
            app.manage(ShellProcesses::default());
            app.manage(CodexAppServer::default());
            app.manage(sidecar::SidecarTransactions::default());

            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.with_webview(|webview| {
                    use webkit2gtk::WebViewExt;
                    webview.inner().connect_web_process_terminated(|_, reason| {
                        diagnostics::record_durable("webview.terminated", serde_json::json!({"reason": format!("{reason:?}")}));
                    });
                });
            }

            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }
            Ok(())
        })
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            diagnostics::diagnostic_event,
            diagnostics::diagnostic_log_path,
            scoped_fs::directory_open,
            scoped_fs::directory_close,
            scoped_fs::directory_stat_many,
            scoped_fs::directory_read_range,
            scoped_fs::directory_read_file,
            scoped_fs::directory_io,
            sidecar::sidecar_open_database,
            sidecar::sidecar_database_execute,
            sidecar::sidecar_database_select,
            sidecar::sidecar_close_database,
            sidecar::sidecar_begin,
            sidecar::sidecar_open_scope,
            sidecar::sidecar_execute,
            sidecar::sidecar_select,
            sidecar::sidecar_finish,
            get_home_dir,
            get_root_dir,
            get_path_sources,
            get_current_dir,
            get_app_data_dir,
            get_app_config_dir,
            fs_commands::fs_stat,
            fs_commands::fs_stat_many,
            fs_commands::fs_mkdir,
            fs_commands::fs_read_file,
            fs_commands::fs_write_file,
            fs_commands::fs_append_file,
            fs_commands::fs_read_dir,
            fs_commands::fs_rename,
            fs_commands::fs_remove,
            fs_commands::fs_exists,
            // Native search commands for INativeShell
            native_capabilities,
            search_ripgrep,
            search_fd,
            shell_exec,
            git_command,
            session_shell_exec,
            shell_cancel,
            mcp_process::mcp_start,
            mcp_process::mcp_send,
            mcp_process::mcp_poll,
            mcp_process::mcp_stop,
            codex_start,
            codex_send,
            codex_poll,
            codex_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app, event| match event {
        tauri::RunEvent::Ready => diagnostics::record("app.ready", serde_json::json!({})),
        tauri::RunEvent::ExitRequested { code, .. } => diagnostics::record("app.exit_requested", serde_json::json!({"code": code})),
        tauri::RunEvent::Exit => { app.state::<mcp_process::MCPProcesses>().shutdown(); diagnostics::clean_exit(); },
        _ => {},
    });
}
