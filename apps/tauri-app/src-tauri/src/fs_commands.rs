use std::path::{Path, PathBuf};
use tauri::State;
use crate::{AppPaths, is_allowed, atomic_file};

// ── FS commands — bypass plugin-fs scope (dotfiles, NFS, symlinks) ────────────
//
// Tauri's plugin-fs uses glob crate with require_literal_leading_dot=true,
// so `path/**` never matches `path/.hidden`. We expose our own FS commands
// and enforce path security ourselves: every operation must be under
// nestos_dir or home_dir (resolved without following symlinks via normalize_path).

#[derive(serde::Serialize)]
pub(crate) struct FsStatResult {
    size:         u64,
    mtime_ms:     i64,
    birthtime_ms: i64,
    is_directory: bool,
    is_symbolic_link: bool,
    is_file: bool,
}

#[derive(serde::Serialize)]
pub(crate) struct FsDirEntry {
    name:         String,
    is_directory: bool,
}

async fn run_fs<T: Send + 'static>(paths: AppPaths,
    operation: impl FnOnce(AppPaths) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || operation(paths))
        .await.map_err(|error| format!("filesystem worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn fs_stat(path: String, state: State<'_, AppPaths>) -> Result<Option<FsStatResult>, String> {
    run_fs(state.inner().clone(), move |state| {
        Ok(stat_one(Path::new(&path), &state))
    }).await
}

/// One IPC for many stats. The VFS capability check walks every path prefix and issues the segment
/// checks concurrently; without this each segment would be its own `fs_stat` round trip.
#[tauri::command]
pub(crate) async fn fs_stat_many(paths: Vec<String>, state: State<'_, AppPaths>) -> Result<Vec<Option<FsStatResult>>, String> {
    run_fs(state.inner().clone(), move |state| {
        Ok(paths.iter().map(|path| stat_one(Path::new(path), &state)).collect())
    }).await
}

fn stat_one(p: &Path, paths: &AppPaths) -> Option<FsStatResult> {
    if !is_allowed(p, paths) { return None; }
    let m = std::fs::symlink_metadata(p).ok()?;
    let ms = |t: std::time::SystemTime| {
        t.duration_since(std::time::UNIX_EPOCH).ok()
            .map(|d| d.as_millis() as i64).unwrap_or(0)
    };
    Some(FsStatResult {
        size:         m.len(),
        mtime_ms:     m.modified().ok().map(ms).unwrap_or(0),
        birthtime_ms: m.created().ok().map(ms).unwrap_or(0),
        is_directory: m.is_dir(),
        is_symbolic_link: m.file_type().is_symlink(),
        is_file: m.is_file(),
    })
}

#[tauri::command]
pub(crate) fn fs_mkdir(path: String, state: State<AppPaths>) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !is_allowed(&p, &state) { return Err(format!("path not allowed: {path}")); }
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn fs_read_file(path: String, state: State<'_, AppPaths>) -> Result<tauri::ipc::Response, String> {
    run_fs(state.inner().clone(), move |state| {
        let p = PathBuf::from(&path);
        if !is_allowed(&p, &state) { return Err(format!("path not allowed: {path}")); }
        std::fs::read(&p).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
    }).await
}

#[tauri::command]
pub(crate) fn fs_write_file(path: String, data: Vec<u8>, state: State<AppPaths>) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !is_allowed(&p, &state) { return Err(format!("path not allowed: {path}")); }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    atomic_file::write(&p, &data).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn fs_append_file(path: String, data: Vec<u8>, state: State<AppPaths>) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !is_allowed(&p, &state) { return Err(format!("path not allowed: {path}")); }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().append(true).create(true).open(&p)
        .map_err(|e| e.to_string())?;
    f.write_all(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn fs_read_dir(path: String, state: State<'_, AppPaths>) -> Result<Vec<FsDirEntry>, String> {
    run_fs(state.inner().clone(), move |state| {
        let p = PathBuf::from(&path);
        if !is_allowed(&p, &state) { return Err(format!("path not allowed: {path}")); }
        let iter = std::fs::read_dir(&p).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for entry in iter.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_directory = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            out.push(FsDirEntry { name, is_directory });
        }
        Ok(out)
    }).await
}

#[tauri::command]
pub(crate) fn fs_rename(from: String, to: String, state: State<AppPaths>) -> Result<(), String> {
    let (fp, tp) = (PathBuf::from(&from), PathBuf::from(&to));
    if !is_allowed(&fp, &state) || !is_allowed(&tp, &state) {
        return Err("path not allowed".into());
    }
    std::fs::rename(&fp, &tp).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn fs_remove(path: String, recursive: bool, state: State<AppPaths>) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !is_allowed(&p, &state) { return Err(format!("path not allowed: {path}")); }
    let meta = match std::fs::metadata(&p) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    if meta.is_dir() {
        if recursive { std::fs::remove_dir_all(&p) } else { std::fs::remove_dir(&p) }
    } else {
        std::fs::remove_file(&p)
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn fs_exists(path: String, state: State<'_, AppPaths>) -> Result<bool, String> {
    run_fs(state.inner().clone(), move |state| {
        let p = PathBuf::from(&path);
        Ok(is_allowed(&p, &state) && p.exists())
    }).await
}

#[cfg(all(test, unix))]
mod stat_type_tests {
    use super::*;
    use crate::{RootSource, HomeSource};

    #[test]
    fn filesystem_reads_run_off_the_caller_thread() {
        let root = std::env::temp_dir();
        let paths = AppPaths { config_dir: root.clone(), root_dir: root.clone(), home_dir: root.clone(), root_source: RootSource::Default, home_source: HomeSource::ProcessCwd };
        let caller = std::thread::current().id();
        tauri::async_runtime::block_on(run_fs(paths, move |paths| {
            assert_ne!(caller, std::thread::current().id());
            assert!(stat_one(&paths.root_dir, &paths).unwrap().is_directory);
            Ok(())
        })).unwrap();
    }

    #[test]
    fn reports_links_without_following_them() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("nestos-stat-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let paths = AppPaths { config_dir: root.clone(), root_dir: root.clone(), home_dir: root.clone(), root_source: RootSource::Default, home_source: HomeSource::ProcessCwd };
        let file = root.join("file");
        std::fs::write(&file, b"content").unwrap();
        for (name, target) in [("file-link", file.clone()), ("dir-link", root.clone()), ("dangling", root.join("missing"))] {
            let link = root.join(name);
            std::os::unix::fs::symlink(target, &link).unwrap();
            let stat = stat_one(&link, &paths).unwrap();
            assert!(stat.is_symbolic_link);
            assert!(!stat.is_file && !stat.is_directory);
        }
        let regular = stat_one(&file, &paths).unwrap();
        assert!(regular.is_file && !regular.is_symbolic_link);
        assert!(stat_one(&root.join("missing"), &paths).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
