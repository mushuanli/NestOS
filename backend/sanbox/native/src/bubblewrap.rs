use std::process::Command;
use crate::{LinuxPolicy, Mount, NetworkAccess};

pub(crate) fn command(script: &str, cwd: &str, mounts: &[Mount], network: NetworkAccess, policy: &LinuxPolicy) -> Command {
    let mut result = Command::new("/usr/bin/bwrap");
    result.args(&policy.args);
    if network == NetworkAccess::Deny { result.arg("--unshare-net"); }
    for path in &policy.runtime_paths { result.args(["--ro-bind-try", path, path]); }
    result.args(["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]);
    if network == NetworkAccess::Allow {
        for path in &policy.network_paths { result.args(["--ro-bind-try", path, path]); }
    }
    for mount in mounts {
        result.args([if mount.writable { "--bind" } else { "--ro-bind" }, &mount.source, &mount.target]);
    }
    result.args(["--chdir", cwd, "--", "bash", "--noprofile", "--norc", "-c", script]);
    result
}
