pub use itookit_sanbox::Mount;
use itookit_sanbox::{session_command, NetworkAccess};
use std::process::Command;

/// Session/Flow Bash always uses the shared package with host-owned deny-network policy.
pub fn command(script: &str, cwd: &str, mounts: &[Mount]) -> Result<Command, String> {
    session_command(script, cwd, mounts, NetworkAccess::Deny)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn a_session_without_a_mount_explains_how_to_enable_bash() {
        let error = command("echo hi", "/", &[]).unwrap_err();
        assert!(error.contains("requires a mounted Session directory"), "{error}");
    }

    #[test]
    fn confines_bash_to_readonly_and_writable_grants() {
        let root = std::env::temp_dir().join(format!("session-bash-{}", std::process::id()));
        std::fs::create_dir_all(root.join("ro")).unwrap();
        std::fs::create_dir_all(root.join("rw")).unwrap();
        std::fs::write(root.join("ro/input"), "allowed").unwrap();
        std::fs::write(root.join("secret"), "outside").unwrap();
        let mounts = [Mount { source: root.join("ro").to_string_lossy().into(), target: "/input".into(), writable: false },
            Mount { source: root.join("rw").to_string_lossy().into(), target: "/workspace".into(), writable: true }];
        let script = format!("set -e; test ! -e '{}/secret'; if echo denied > /input/new 2>/dev/null; then exit 9; fi; bash -c 'cat /input/input > output'; cat output", root.display());
        let output = command(&script, "/workspace", &mounts).unwrap().output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(output.stdout, b"allowed");
        assert_eq!(std::fs::read(root.join("rw/output")).unwrap(), b"allowed");
        assert!(!root.join("ro/new").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn never_falls_back_to_a_host_shell() {
        let root = std::env::temp_dir().join(format!("session-bash-shell-{}", std::process::id()));
        std::fs::create_dir_all(root.join("rw")).unwrap();
        let mounts = [Mount { source: root.join("rw").to_string_lossy().into(), target: "/workspace".into(), writable: true }];
        let built = command("echo hi", "/workspace", &mounts).unwrap();
        // The only program this crate will ever spawn is the namespace builder: there is no
        // host-shell path to fall back to when isolation is unavailable.
        assert_eq!(built.get_program(), "/usr/bin/bwrap");
        let args: Vec<String> = built.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        let switches: Vec<usize> = args.iter().enumerate().filter(|(_, arg)| arg.as_str() == "-c").map(|(index, _)| index).collect();
        assert_eq!(switches.len(), 1, "{args:?}");
        // The script stays one `-c` argument of the inner bash, never a concatenated host command.
        assert_eq!(args[switches[0] + 1], "echo hi");
        assert!(args.windows(2).any(|pair| pair[0] == "--" && pair[1] == "bash"), "{args:?}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clears_host_credentials_and_exposes_only_the_fixed_session_environment() {
        let root = std::env::temp_dir().join(format!("session-bash-env-{}", std::process::id()));
        std::fs::create_dir_all(root.join("rw")).unwrap();
        let mounts = [Mount { source: root.join("rw").to_string_lossy().into(), target: "/workspace".into(), writable: true }];
        std::env::set_var("NESTOS_HOST_SECRET", "must-not-leak");
        let output = command("set -e; test -z \"$NESTOS_HOST_SECRET\"; printf '%s|%s' \"$HOME\" \"$LANG\"", "/workspace", &mounts)
            .unwrap().output().unwrap();
        std::env::remove_var("NESTOS_HOST_SECRET");
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(output.stdout, b"/tmp|C.UTF-8");
        let mut configured: Vec<String> = command("true", "/workspace", &mounts).unwrap()
            .get_envs().map(|(key, _)| key.to_string_lossy().into_owned()).collect();
        configured.sort();
        assert_eq!(configured, ["HOME", "LANG", "PATH"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_ungranted_cwd_and_reserved_or_traversing_paths() {
        assert!(command("true", "/workspace", &[]).is_err());
        let root = std::env::temp_dir().join(format!("session-bash-path-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let mounts = [Mount { source: root.to_string_lossy().into(), target: "/workspace".into(), writable: true }];
        for path in ["/", "/usr/bin", "/workspace/../etc", "/workspace/", "relative", "/workspace//sub"] {
            assert!(command("true", path, &mounts).is_err(), "{path}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn desktop_session_bash_uses_a_private_network_namespace() {
        let root = std::env::temp_dir().join(format!("session-bash-network-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let mounts = [Mount { source: root.to_string_lossy().into(), target: "/workspace".into(), writable: true }];
        let output = command("readlink /proc/self/ns/net", "/workspace", &mounts).unwrap().output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let host = std::fs::read_link("/proc/self/ns/net").unwrap();
        assert_ne!(String::from_utf8(output.stdout).unwrap().trim(), host.to_str().unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn desktop_cancellation_stops_the_sandbox_before_releasing_its_workspace() {
        let root = std::env::temp_dir().join(format!("session-bash-cancel-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let mounts = [Mount { source: root.to_string_lossy().into(), target: "/workspace".into(), writable: true }];
        let script = "printf started > started; (sleep 1; printf leaked > late) & wait";
        let result = crate::bash_process::execute_command(command(script, "/workspace", &mounts).unwrap(), 300,
            &std::sync::atomic::AtomicBool::new(false)).unwrap();
        assert_ne!(result.2, 0);
        assert_eq!(std::fs::read(root.join("started")).unwrap(), b"started");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        assert!(!root.join("late").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
