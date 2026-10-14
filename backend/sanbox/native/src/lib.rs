mod bubblewrap;
mod policy;
mod seatbelt;

use std::process::{Command, Stdio};
use policy::{canonical_mounts, native_cwd};

#[derive(Clone, Debug)]
pub struct Mount {
    pub source: String,
    pub target: String,
    pub writable: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum NetworkAccess {
    #[default]
    Deny,
    Allow,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinuxPolicy { args: Vec<String>, runtime_paths: Vec<String>, network_paths: Vec<String> }

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeatbeltPolicy { rules: Vec<String>, runtime_paths: Vec<String> }

#[derive(serde::Deserialize)]
struct RuntimePolicy { linux: LinuxPolicy, seatbelt: SeatbeltPolicy }

fn runtime_policy() -> Result<RuntimePolicy, String> {
    serde_json::from_str(include_str!("../../src/runtime-policy.json")).map_err(|e| e.to_string())
}

/// Build a command from host-validated directory capabilities, never frontend argv/profile data.
pub fn session_command(script: &str, cwd: &str, mounts: &[Mount], network: NetworkAccess) -> Result<Command, String> {
    let mut result = command_for_platform(std::env::consts::OS, script, cwd, mounts, network)?;
    result.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    #[cfg(unix)]
    { use std::os::unix::process::CommandExt; result.process_group(0); }
    Ok(result)
}

fn command_for_platform(platform: &str, script: &str, cwd: &str, mounts: &[Mount], network: NetworkAccess) -> Result<Command, String> {
    if !matches!(platform, "linux" | "macos") { return Err("Session Bash isolation is not available on this platform".into()); }
    if script.contains('\0') { return Err("Invalid Bash command".into()); }
    let mounts = canonical_mounts(mounts)?;
    if platform == "macos" && mounts.iter().any(|mount| mount.source != mount.target) {
        return Err("Virtual mount namespaces require a namespace-capable backend; seatbelt only supports identical host paths".into());
    }
    let native_cwd = native_cwd(cwd, &mounts)?;
    let policy = runtime_policy()?;
    let mut result = match platform {
        "linux" => bubblewrap::command(script, cwd, &mounts, network, &policy.linux),
        _ => seatbelt::command(script, &native_cwd, &mounts, network, &policy.seatbelt),
    };
    result.env_clear().env("PATH", "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        .env("HOME", if platform == "linux" { "/tmp" } else { &native_cwd })
        .env("LANG", if platform == "linux" { "C.UTF-8" } else { "C" });
    Ok(result)
}

#[cfg(test)]
mod tests;
