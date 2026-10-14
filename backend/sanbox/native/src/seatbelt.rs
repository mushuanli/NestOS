use std::process::Command;
use crate::{Mount, NetworkAccess, SeatbeltPolicy};

fn quote(path: &str) -> String {
    format!("\"{}\"", path.replace('\\', "\\\\").replace('"', "\\\""))
}

pub(crate) fn command(script: &str, cwd: &str, mounts: &[Mount], network: NetworkAccess, policy: &SeatbeltPolicy) -> Command {
    let mut rules = policy.rules.clone();
    for path in policy.runtime_paths.iter().chain(mounts.iter().map(|mount| &mount.source)) {
        rules.push(format!("(allow file-read* file-map-executable (subpath {}))", quote(path)));
    }
    for mount in mounts.iter().filter(|mount| mount.writable) {
        rules.push(format!("(allow file-write* (subpath {}))", quote(&mount.source)));
    }
    if network == NetworkAccess::Allow { rules.push("(allow network*)".into()); }
    let mut result = Command::new("/usr/bin/sandbox-exec");
    result.args(["-p", &rules.join("\n"), "/bin/bash", "--noprofile", "--norc", "-c", script]).current_dir(cwd);
    result
}
