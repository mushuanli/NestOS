use std::collections::HashSet;
use std::path::{Component, Path};
use crate::Mount;

pub(crate) fn inside(path: &str, root: &str) -> bool {
    path == root || path.starts_with(&format!("{root}/"))
}

fn validate_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') || path == "/" || path.ends_with('/') || path.contains("//")
        || path.chars().any(char::is_control) || path.split('/').any(|part| part == "." || part == "..")
        || Path::new(path).components().any(|part| !matches!(part, Component::RootDir | Component::Normal(_))) {
        return Err("Invalid Session Bash path".into());
    }
    Ok(())
}

fn validate_target(path: &str) -> Result<(), String> {
    validate_path(path)?;
    if ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/proc", "/dev", "/sys", "/tmp", "/System"]
        .iter().any(|root| inside(path, root)) { return Err("Session mount overlaps runtime directories".into()); }
    Ok(())
}

fn validate_source(path: &str, writable: bool) -> Result<(), String> {
    validate_path(path)?;
    if ["/proc", "/dev", "/sys"].iter().any(|root| inside(path, root)) { return Err("Reserved Session source".into()); }
    if !writable { return Ok(()); }
    let reserved = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/System", "/Library", "/private/etc"];
    if reserved.iter().any(|root| inside(path, root) || inside(root, path))
        || ["/tmp", "/private/tmp", "/var", "/private/var"].contains(&path) {
        return Err("Runtime/shared path cannot be a writable Session source".into());
    }
    Ok(())
}

pub(crate) fn canonical_mounts(mounts: &[Mount]) -> Result<Vec<Mount>, String> {
    if mounts.is_empty() { return Err("Session Bash requires a mounted Session directory; mount one before running commands".into()); }
    let mut targets = HashSet::new();
    let mut result = Vec::new();
    for mount in mounts {
        validate_target(&mount.target)?;
        if !targets.insert(&mount.target) { return Err("Duplicate Session mount target".into()); }
        validate_path(&mount.source)?;
        let source = std::fs::canonicalize(&mount.source).map_err(|e| e.to_string())?;
        if !source.is_dir() { return Err("Session Bash source must be a directory".into()); }
        let source = source.to_str().ok_or("Session source is not UTF-8")?.to_owned();
        validate_source(&source, mount.writable)?;
        result.push(Mount { source, target: mount.target.clone(), writable: mount.writable });
    }
    for write in result.iter().filter(|mount| mount.writable) {
        if result.iter().any(|read| !read.writable && inside(&read.source, &write.source)) {
            return Err("Read-only grant overlaps writable ancestor".into());
        }
    }
    result.sort_by_key(|mount| mount.target.len());
    Ok(result)
}

pub(crate) fn native_cwd(cwd: &str, mounts: &[Mount]) -> Result<String, String> {
    validate_target(cwd)?;
    let mount = mounts.iter().filter(|mount| inside(cwd, &mount.target)).max_by_key(|mount| mount.target.len())
        .ok_or("Bash cwd has no Session directory grant")?;
    let path = Path::new(&mount.source).join(cwd[mount.target.len()..].trim_start_matches('/'));
    let real = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let real = real.to_str().ok_or("Session cwd is not UTF-8")?;
    if !Path::new(real).is_dir() || !inside(real, &mount.source) { return Err("Bash cwd escapes its Session directory grant".into()); }
    Ok(real.to_owned())
}
