use super::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Fixture { root: PathBuf }
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!("sanbox-rust-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(root.join("rw/sub")).unwrap();
        std::fs::create_dir_all(root.join("ro")).unwrap();
        Self { root: root.canonicalize().unwrap() }
    }
    fn mount(&self, directory: &str, target: &str, writable: bool) -> Mount {
        Mount { source: self.root.join(directory).to_str().unwrap().into(), target: target.into(), writable }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { std::fs::remove_dir_all(&self.root).unwrap(); }
}

fn args(command: &Command) -> Vec<String> {
    command.get_args().map(|arg| arg.to_str().unwrap().to_owned()).collect()
}

#[test]
fn linux_uses_shared_defaults_and_explicit_mount_permissions() {
    let fixture = Fixture::new();
    let mounts = [fixture.mount("rw", "/workspace", true), fixture.mount("ro", "/input", false)];
    let command = command_for_platform("linux", "echo hi", "/workspace/sub", &mounts, NetworkAccess::Deny).unwrap();
    assert_eq!(command.get_program(), "/usr/bin/bwrap");
    let args = args(&command);
    for flag in ["--unshare-net", "--unshare-user", "--unshare-pid", "--new-session"] {
        assert!(args.iter().any(|arg| arg == flag));
    }
    assert!(args.windows(3).any(|a| a == ["--bind", &mounts[0].source, "/workspace"]));
    assert!(args.windows(3).any(|a| a == ["--ro-bind", &mounts[1].source, "/input"]));
    assert_eq!(args.last().unwrap(), "echo hi");
    let command = command_for_platform("linux", "true", "/workspace", &mounts, NetworkAccess::Allow).unwrap();
    assert!(!self::args(&command).iter().any(|arg| arg == "--unshare-net"));
}

#[test]
fn macos_applies_seatbelt_to_native_cwd_and_escapes_profile_paths() {
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.root.join("quoted\"\\directory")).unwrap();
    let mounts = [fixture.mount("rw", "/workspace", true), fixture.mount("quoted\"\\directory", "/input", false)];
    let script = "echo '\"; (allow default)'";
    let cwd = fixture.root.join("rw/sub");
    let command = seatbelt::command(script, cwd.to_str().unwrap(), &mounts, NetworkAccess::Deny, &runtime_policy().unwrap().seatbelt);
    assert_eq!(command.get_program(), "/usr/bin/sandbox-exec");
    assert_eq!(command.get_current_dir().unwrap(), fixture.root.join("rw/sub"));
    let args = args(&command);
    assert_eq!(args[0], "-p");
    assert!(args[1].contains("(deny default)"));
    assert!(args[1].contains("quoted\\\"\\\\directory"));
    assert!(!args[1].contains("(allow network*)"));
    assert!(!args[1].contains("(subpath \"/System\")"));
    assert!(!args[1].contains("(subpath \"/System/Volumes/Data\")"));
    assert!(!args[1].contains(script));
    assert_eq!(args.last().unwrap(), script);
}

#[test]
fn rejects_duplicate_targets_and_ambiguous_source_permissions() {
    let f = Fixture::new();
    let duplicate = [f.mount("rw", "/workspace", true), f.mount("ro", "/workspace", false)];
    assert!(canonical_mounts(&duplicate).unwrap_err().contains("Duplicate"));
    let overlap = [f.mount("rw", "/workspace", true), f.mount("rw/sub", "/input", false)];
    assert!(canonical_mounts(&overlap).unwrap_err().contains("overlaps"));
}

#[test]
fn rejects_reserved_or_traversing_targets_and_ungranted_cwd() {
    let f = Fixture::new();
    for path in ["/", "/usr/bin", "/workspace/../etc", "/workspace/", "relative", "/workspace//sub", "/workspace/\n"] {
        let mounts = [f.mount("rw", path, true)];
        assert!(canonical_mounts(&mounts).is_err(), "{path}");
    }
    let mounts = [f.mount("rw", "/workspace", true)];
    for cwd in ["/workspace-other", "/input", "/workspace/../input"] {
        assert!(native_cwd(cwd, &mounts).is_err(), "{cwd}");
    }
}

#[test]
#[cfg(unix)]
fn rejects_cwd_symlink_escape_after_resolving_the_native_directory() {
    let f = Fixture::new();
    std::os::unix::fs::symlink(f.root.join("ro"), f.root.join("rw/link")).unwrap();
    let mounts = [f.mount("rw", "/workspace", true)];
    assert!(native_cwd("/workspace/link", &mounts).unwrap_err().contains("escapes"));
}

#[test]
fn never_downgrades_unknown_platforms_or_missing_grants_to_native() {
    assert!(command_for_platform("windows", "true", "/", &[], NetworkAccess::Deny).is_err());
    assert!(command_for_platform("linux", "true", "/", &[], NetworkAccess::Deny).unwrap_err().contains("requires a mounted"));
}

#[test]
fn macos_rejects_virtual_aliases_instead_of_silently_changing_the_namespace() {
    let fixture = Fixture::new();
    let mounts = [fixture.mount("rw", "/workspace", true)];
    assert!(command_for_platform("macos", "pwd", "/workspace", &mounts, NetworkAccess::Deny)
        .unwrap_err().contains("namespace-capable"));
}

#[test]
#[cfg(target_os = "linux")]
fn native_bash_uses_workspace_and_sibling_grants() {
    if std::env::var("SANBOX_TEST_NATIVE").as_deref() != Ok("1") { return; }
    let fixture = Fixture::new();
    std::fs::write(fixture.root.join("rw/main.txt"), "project").unwrap();
    std::fs::write(fixture.root.join("ro/guide.txt"), "reference").unwrap();
    let mounts = [fixture.mount("rw", "/workspace", true), fixture.mount("ro", "/reference", false)];
    let script = "set -eu; test \"$(pwd)\" = /workspace; test \"$(cat main.txt)\" = project; test \"$(cat ../reference/guide.txt)\" = reference; test \"$(cat /reference/guide.txt)\" = reference; if echo denied > /reference/guide.txt 2>/dev/null; then exit 12; fi; echo updated > /workspace/main.txt";
    let result = session_command(script, "/workspace", &mounts, NetworkAccess::Deny).unwrap().output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    assert_eq!(std::fs::read_to_string(fixture.root.join("rw/main.txt")).unwrap(), "updated\n");
    assert_eq!(std::fs::read_to_string(fixture.root.join("ro/guide.txt")).unwrap(), "reference");
}
