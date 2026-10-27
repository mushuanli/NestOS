//! Host-side git for isolated Flow workspaces.
//!
//! Deliberately narrower than `shell_exec`: a host-injected worktree manager needs to create and
//! remove git worktrees in a user repository, but the webview must not gain a general host shell.
//! Accepted shape:
//!
//! - `args` is an argv array (no shell), limited to the exact worktree-manager command shapes;
//! - options that can execute arbitrary code or redirect the repository are rejected
//!   (`-c`, `--exec-path`, `--git-dir`, `--work-tree`, `--upload-pack`, `--receive-pack`,
//!   `--config-env`, `--namespace`, `-C`);
//! - IPC resolves cwd through an existing directory capability; it must be a repository root;
//! - worktree add/remove require a second grant and target a strict child without symlink traversal;
//! - inherited environment is cleared; system/global config, hooks, fsmonitor and prompts are off;
//! - the worktree is explicit and repositories with external filters are rejected before execution.

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::AtomicBool;

/// Upper bound on argv entries; enough for `worktree add -b <branch> <dir> <base>`.
pub const MAX_ARGS: usize = 16;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;

/// Options rejected anywhere in the argv: they can execute programs or retarget the repository.
const FORBIDDEN_OPTIONS: &[&str] = &[
    "-c", "--exec-path", "--git-dir", "--work-tree", "--upload-pack", "--receive-pack",
    "--config-env", "--namespace", "-C", "--no-index", "--worktree",
];

/// Validate the whitelisted argv shape. Pure so the rules stay testable without spawning git.
pub fn validate_args(args: &[String]) -> Result<(), String> {
    if args.is_empty() || args.len() > MAX_ARGS {
        return Err(format!("git argv must hold 1..{MAX_ARGS} entries"));
    }
    for arg in args {
        if arg.is_empty() || arg.contains('\0') {
            return Err("git arguments must be non-empty without NUL bytes".into());
        }
        // `-c` style options may also be smuggled as `--config-env=...`; compare the option name.
        let name = arg.split('=').next().unwrap_or(arg);
        if FORBIDDEN_OPTIONS.contains(&name) {
            return Err(format!("git option not allowed: {name}"));
        }
    }
    if allowed_shape(args) { Ok(()) } else { Err("git command shape not allowed".into()) }
}

fn allowed_shape(args: &[String]) -> bool {
    let parts: Vec<&str> = args.iter().map(String::as_str).collect();
    let operand = |value: &str| !value.is_empty() && !value.starts_with('-') && !value.contains(['\n', '\r']);
    let branch = |value: &str| value.starts_with("flow/") && operand(value);
    let path = |value: &str| Path::new(value).is_absolute() && operand(value);
    match parts.as_slice() {
        ["worktree", "add", "-b", name, directory, base] => branch(name) && path(directory) && operand(base),
        ["worktree", "remove", directory] | ["worktree", "remove", "--force", directory] => path(directory),
        ["worktree", "list", "--porcelain"] | ["status", "--porcelain"] => true,
        ["branch", "-D", name] | ["merge", "--ff-only", name] => branch(name),
        ["rev-parse", "HEAD"] | ["rev-parse", "--is-inside-work-tree"] => true,
        ["rev-parse", "--verify", "--quiet", name] => name.starts_with("refs/heads/flow/") && operand(name),
        _ => false,
    }
}

/// Resolve cwd from an existing directory capability, never from an arbitrary IPC path.
pub fn run_scoped(repository_id: &str, args: &[String], timeout_ms: Option<u64>,
    scopes: &crate::scoped_directory::DirectoryScopes, workspace_id: Option<&str>) -> Result<(String, String, i32), String> {
    validate_args(args)?;
    let root = scopes.0.lock().map_err(|e| e.to_string())?.get(repository_id)
        .cloned().ok_or("git repository grant has been closed")?;
    crate::directory_boundary::resolve(&root, "")?;
    validate_workspace_target(args, workspace_id, scopes)?;
    let cwd = root.to_str().ok_or("git repository path is not UTF-8")?;
    run(cwd, args, timeout_ms)
}

fn validate_workspace_target(args: &[String], workspace_id: Option<&str>,
    scopes: &crate::scoped_directory::DirectoryScopes) -> Result<(), String> {
    let target = match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["worktree", "add", "-b", _, directory, _] => (*directory).to_string(),
        ["worktree", "remove", directory] | ["worktree", "remove", "--force", directory] => (*directory).to_string(),
        _ => return Ok(()),
    };
    let id = workspace_id.ok_or("git worktree operation requires a destination directory grant")?;
    let root = scopes.0.lock().map_err(|e| e.to_string())?.get(id)
        .cloned().ok_or("git workspace grant has been closed")?;
    let relative = Path::new(&target).strip_prefix(&root).map_err(|_| "worktree target is outside directory grant")?;
    let relative = relative.to_str().ok_or("worktree path is not UTF-8")?;
    let resolved = crate::directory_boundary::resolve(&root, relative)?;
    if resolved == root { return Err("cannot create or remove the workspace grant root".into()); }
    Ok(())
}

/// Run `git <args>` in `cwd` after validating both, reusing the bounded Bash process runner.
pub fn run(cwd: &str, args: &[String], timeout_ms: Option<u64>) -> Result<(String, String, i32), String> {
    validate_args(args)?;
    let directory = Path::new(cwd);
    if !directory.join(".git").exists() {
        return Err(format!("git working directory is not a repository root: {cwd}"));
    }
    let timeout = match timeout_ms {
        Some(value) if value == 0 || value > MAX_TIMEOUT_MS => {
            return Err(format!("Invalid git timeout (1..{MAX_TIMEOUT_MS}ms)"))
        }
        Some(value) => value,
        None => DEFAULT_TIMEOUT_MS,
    };
    let started = std::time::Instant::now();
    reject_repository_filters(cwd, timeout)?;
    let remaining = timeout.saturating_sub(started.elapsed().as_millis() as u64);
    if remaining == 0 { return Err("git configuration validation timed out".into()); }
    crate::bash_process::execute_command(command(cwd, args), remaining, &AtomicBool::new(false))
}

fn reject_repository_filters(cwd: &str, timeout: u64) -> Result<(), String> {
    let args: Vec<String> = ["config", "--includes", "--null", "--name-only", "--get-regexp",
        r"^filter\..*\.(clean|smudge|process)$"].iter().map(|value| value.to_string()).collect();
    let (stdout, stderr, code) = crate::bash_process::execute_command(command(cwd, &args), timeout, &AtomicBool::new(false))?;
    if code == 1 && stdout.is_empty() { return Ok(()); }
    if code == 0 && !stdout.is_empty() { return Err("Host worktree operations do not execute repository filters".into()); }
    Err(format!("Cannot validate git repository filters: {stderr}"))
}

fn command(cwd: &str, args: &[String]) -> Command {
    let mut command = Command::new("git");
    // Even read-only status can execute a repository-configured fsmonitor hook.
    command
        .args(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--no-pager"])
        .args(["--work-tree", cwd])
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    struct GrantedRepo {
        root: std::path::PathBuf,
        workspace: std::path::PathBuf,
        scopes: crate::scoped_directory::DirectoryScopes,
        repository_id: String,
        workspace_id: String,
    }

    impl Drop for GrantedRepo {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); }
    }

    fn granted_repo(name: &str) -> GrantedRepo {
        let root = std::env::temp_dir().join(format!("nestos-git-{name}-{}", std::process::id()));
        let repository = root.join("repository");
        let workspace = root.join("workspaces");
        std::fs::create_dir_all(&repository).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        let git = |args: &[&str]| assert!(Command::new("git").args(args).current_dir(&repository).status().unwrap().success());
        git(&["init", "-q"]);
        git(&["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "initial"]);
        let scopes = crate::scoped_directory::DirectoryScopes::default();
        let grant = |path: &Path| crate::scoped_directory::directory_open(path.to_str().unwrap().into(), &scopes)
            .unwrap()["id"].as_str().unwrap().to_string();
        let repository_id = grant(&repository);
        let workspace_id = grant(&workspace);
        GrantedRepo { root, workspace, scopes, repository_id, workspace_id }
    }

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| part.to_string()).collect()
    }

    #[test]
    fn accepts_the_worktree_shapes_the_manager_uses() {
        assert!(validate_args(&argv(&["worktree", "add", "-b", "flow/s1-abc", "/tmp/wt", "HEAD"])).is_ok());
        assert!(validate_args(&argv(&["worktree", "list", "--porcelain"])).is_ok());
        assert!(validate_args(&argv(&["worktree", "remove", "--force", "/tmp/wt"])).is_ok());
        assert!(validate_args(&argv(&["rev-parse", "HEAD"])).is_ok());
    }

    #[test]
    fn rejects_subcommands_and_shapes_outside_the_allowlist() {
        assert!(validate_args(&argv(&[])).is_err());
        assert!(validate_args(&argv(&["push"])).is_err());
        assert!(validate_args(&argv(&["worktree"])).is_err());
        assert!(validate_args(&argv(&["worktree", "lock", "/tmp/wt"])).is_err());
        let too_many: Vec<String> = (0..MAX_ARGS + 1).map(|_| "list".to_string()).collect();
        assert!(validate_args(&too_many).is_err());
    }

    #[test]
    fn rejects_extra_options_and_non_manager_operations() {
        for parts in [
            vec!["diff", "--output=/tmp/result"], vec!["commit", "--no-verify"],
            vec!["worktree", "add", "-b", "flow/run", "/tmp/work", "--orphan"],
            vec!["worktree", "add", "-b", "main", "/tmp/work", "HEAD"],
            vec!["worktree", "remove", "relative"], vec!["worktree", "prune"],
            vec!["status", "--porcelain", "--ignored"], vec!["merge", "--ff-only", "--abort"],
            vec!["branch", "-D", "main"], vec!["rev-parse", "--verify", "--quiet", "refs/heads/main"],
        ] { assert!(validate_args(&argv(&parts)).is_err(), "{parts:?}"); }
    }

    #[test]
    fn confines_real_worktree_creation_and_removal_to_destination_grants() {
        let fixture = granted_repo("worktree-target");
        let target = fixture.workspace.join("copy");
        let add = argv(&["worktree", "add", "-b", "flow/target", target.to_str().unwrap(), "HEAD"]);
        let run = |args: &[String], id: Option<&str>| run_scoped(&fixture.repository_id, args, None, &fixture.scopes, id);
        assert!(run(&add, None).unwrap_err().contains("destination directory grant"));
        assert!(!target.exists());
        let (_, stderr, code) = run(&add, Some(&fixture.workspace_id)).unwrap();
        assert_eq!(code, 0, "{stderr}");
        assert!(target.join(".git").is_file());
        let remove = argv(&["worktree", "remove", target.to_str().unwrap()]);
        assert_eq!(run(&remove, Some(&fixture.workspace_id)).unwrap().2, 0);
        assert!(!target.exists());
        crate::scoped_directory::directory_close(fixture.workspace_id.clone(), &fixture.scopes).unwrap();
        assert!(run(&add, Some(&fixture.workspace_id)).unwrap_err().contains("workspace grant has been closed"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn worktree_file_io_and_bash_share_the_copy_without_changing_the_repository() {
        use crate::scoped_directory::{directory_open, directory_close, directory_io};
        let fixture = granted_repo("worktree-file-bash");
        let target = fixture.workspace.join("copy");
        let run = |args: &[&str]| run_scoped(&fixture.repository_id, &argv(args), None,
            &fixture.scopes, Some(&fixture.workspace_id)).unwrap();
        assert_eq!(run(&["worktree", "add", "-b", "flow/io", target.to_str().unwrap(), "HEAD"]).2, 0);
        let opened = directory_open(target.to_string_lossy().into(), &fixture.scopes).unwrap();
        let id = opened["id"].as_str().unwrap().to_string();
        directory_io(id.clone(), "write".into(), "probe.txt".into(), None, Some(b"from-file".to_vec()), &fixture.scopes).unwrap();
        let mounts = [crate::session_bash::Mount { source: target.to_string_lossy().into(), target: "/workspace".into(), writable: true }];
        let output = crate::session_bash::command("set -e; test -f .git; test \"$(cat probe.txt)\" = from-file; printf from-bash > probe.txt",
            "/workspace", &mounts).unwrap().output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let bytes = directory_io(id.clone(), "read".into(), "probe.txt".into(), None, None, &fixture.scopes).unwrap();
        assert_eq!(bytes, serde_json::json!(b"from-bash".to_vec()));
        assert!(!fixture.root.join("repository/probe.txt").exists());
        directory_close(id.clone(), &fixture.scopes).unwrap();
        assert!(directory_io(id, "read".into(), "probe.txt".into(), None, None, &fixture.scopes).is_err());
        assert_eq!(run(&["worktree", "remove", "--force", target.to_str().unwrap()]).2, 0);
        assert!(!target.exists());
    }

    #[test]
    fn rejects_outside_parent_traversal_and_grant_root_targets() {
        let fixture = granted_repo("invalid-target");
        for target in [fixture.root.join("outside"), fixture.workspace.join("../outside"), fixture.workspace.clone()] {
            for args in [argv(&["worktree", "add", "-b", "flow/invalid", target.to_str().unwrap(), "HEAD"]),
                argv(&["worktree", "remove", "--force", target.to_str().unwrap()])] {
                assert!(run_scoped(&fixture.repository_id, &args, None, &fixture.scopes, Some(&fixture.workspace_id)).is_err());
            }
        }
        assert!(!fixture.root.join("outside").exists());
        assert!(fixture.workspace.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_worktree_target_ancestors() {
        let fixture = granted_repo("linked-target");
        let outside = fixture.root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, fixture.workspace.join("link")).unwrap();
        let target = fixture.workspace.join("link/copy");
        let args = argv(&["worktree", "add", "-b", "flow/link", target.to_str().unwrap(), "HEAD"]);
        assert!(run_scoped(&fixture.repository_id, &args, None, &fixture.scopes, Some(&fixture.workspace_id))
            .unwrap_err().contains("symlinks are not allowed"));
        assert!(!outside.join("copy").exists());
    }

    #[test]
    fn local_core_worktree_cannot_redirect_the_granted_working_directory() {
        let fixture = granted_repo("local-worktree");
        let repository = fixture.root.join("repository");
        let outside = fixture.root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("outside-only.txt"), "outside").unwrap();
        std::fs::write(repository.join("inside-only.txt"), "inside").unwrap();
        assert!(Command::new("git").args(["config", "core.worktree"]).arg(&outside)
            .current_dir(&repository).status().unwrap().success());
        let (stdout, stderr, code) = run_scoped(&fixture.repository_id, &argv(&["status", "--porcelain"]),
            None, &fixture.scopes, None).unwrap();
        assert_eq!(code, 0, "{stderr}");
        assert!(stdout.contains("inside-only.txt"), "{stdout}");
        assert!(!stdout.contains("outside-only.txt"), "{stdout}");
    }

    #[test]
    fn rejects_repository_checkout_filters_before_they_can_execute() {
        let fixture = granted_repo("checkout-filter");
        let repository = fixture.root.join("repository");
        let marker = fixture.root.join("filter-executed");
        std::fs::write(repository.join(".gitattributes"), "file.txt filter=probe\n").unwrap();
        std::fs::write(repository.join("file.txt"), "tracked content\n").unwrap();
        let git = |args: &[&str]| assert!(Command::new("git").args(args).current_dir(&repository).status().unwrap().success());
        git(&["add", ".gitattributes", "file.txt"]);
        git(&["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "filter fixture"]);
        git(&["config", "filter.probe.smudge", &format!("touch '{}'; cat", marker.display())]);
        let destination = fixture.workspace.join("copy");
        let result = run_scoped(&fixture.repository_id, &argv(&["worktree", "add", "-b", "flow/filter",
            destination.to_str().unwrap(), "HEAD"]), None, &fixture.scopes, Some(&fixture.workspace_id));
        assert!(result.is_err(), "checkout filter was allowed; marker exists: {}", marker.exists());
        assert!(result.unwrap_err().contains("repository filters"));
        assert!(!marker.exists());
        assert!(!destination.exists());
    }

    #[test]
    fn detects_all_filter_commands_in_included_configuration_and_rejects_invalid_config() {
        let fixture = granted_repo("included-filter");
        let repository = fixture.root.join("repository");
        let included = fixture.root.join("filters.conf");
        assert!(Command::new("git").args(["config", "include.path"]).arg(&included)
            .current_dir(&repository).status().unwrap().success());
        let args = argv(&["rev-parse", "HEAD"]);
        for key in ["clean", "smudge", "process"] {
            std::fs::write(&included, format!("[filter \"probe\"]\n{key} = cat\n")).unwrap();
            assert!(run_scoped(&fixture.repository_id, &args, None, &fixture.scopes, None)
                .unwrap_err().contains("do not execute repository filters"));
        }
        std::fs::write(&included, "[broken\n").unwrap();
        assert!(run_scoped(&fixture.repository_id, &args, None, &fixture.scopes, None)
            .unwrap_err().contains("Cannot validate git repository filters"));
    }

    #[test]
    fn resolves_repository_handles_and_rejects_closed_or_unknown_grants() {
        let dir = std::env::temp_dir().join(format!("nestos-host-git-grant-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(Command::new("git").args(["init", "-q"]).current_dir(&dir).status().unwrap().success());
        let scopes = crate::scoped_directory::DirectoryScopes::default();
        let args = argv(&["rev-parse", "--is-inside-work-tree"]);
        assert!(run_scoped("missing", &args, None, &scopes, None).unwrap_err().contains("grant has been closed"));
        let opened = crate::scoped_directory::directory_open(dir.to_str().unwrap().into(), &scopes).unwrap();
        let id = opened["id"].as_str().unwrap();
        let (stdout, _, code) = run_scoped(id, &args, None, &scopes, None).unwrap();
        assert_eq!(code, 0);
        assert_eq!(stdout.trim(), "true");
        crate::scoped_directory::directory_close(id.into(), &scopes).unwrap();
        assert!(run_scoped(id, &args, None, &scopes, None).unwrap_err().contains("grant has been closed"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ignores_inherited_repository_redirection() {
        let probe = "NESTOS_HOST_GIT_ENV_PROBE";
        if let Ok(cwd) = std::env::var(probe) {
            let (_, stderr, code) = run(&cwd, &argv(&["rev-parse", "--is-inside-work-tree"]), None).unwrap();
            assert_eq!(code, 0, "{stderr}");
            return;
        }
        let dir = std::env::temp_dir().join(format!("nestos-host-git-env-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(Command::new("git").args(["init", "-q"]).current_dir(&dir).status().unwrap().success());
        // A child test process gives this test hostile inherited environment without global races.
        let result = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "host_git::tests::ignores_inherited_repository_redirection", "--nocapture"])
            .env(probe, &dir).env("GIT_DIR", dir.join("missing-git-dir")).output().unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(result.status.success(), "{}{}", String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
    }

    #[test]
    fn rejects_options_that_can_execute_code_or_retarget_the_repository() {
        for option in ["-c", "--exec-path", "--git-dir", "--work-tree", "--upload-pack", "--config-env", "-C"] {
            let args = argv(&["rev-parse", option]);
            assert!(validate_args(&args).is_err(), "expected {option} to be rejected");
            let with_value = argv(&["status", &format!("{option}=x")]);
            assert!(validate_args(&with_value).is_err(), "expected {option}=… to be rejected");
        }
        assert!(validate_args(&argv(&["rev-parse", "bad\0arg"])).is_err());
    }

    #[test]
    fn refuses_to_run_outside_a_repository_root() {
        let dir = std::env::temp_dir().join("nestos-host-git-not-a-repo");
        let _ = std::fs::create_dir_all(&dir);
        let error = run(dir.to_str().unwrap(), &argv(&["rev-parse", "HEAD"]), None).unwrap_err();
        assert!(error.contains("not a repository root"), "{error}");
    }

    #[test]
    fn runs_a_whitelisted_command_inside_a_real_repository() {
        let dir = std::env::temp_dir().join(format!("nestos-host-git-repo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Set the repository up with std::process directly: `init` is intentionally not whitelisted.
        let status = Command::new("git").args(["init", "-q"]).current_dir(&dir)
            .stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap();
        assert!(status.success());

        let (stdout, _stderr, code) = run(dir.to_str().unwrap(), &argv(&["rev-parse", "--is-inside-work-tree"]), None).unwrap();
        assert_eq!(code, 0);
        assert_eq!(stdout.trim(), "true");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn status_does_not_execute_a_repository_fsmonitor() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("nestos-host-git-monitor-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(Command::new("git").args(["init", "-q"]).current_dir(&dir).status().unwrap().success());
        let monitor = dir.join("monitor.sh");
        std::fs::write(&monitor, "#!/bin/sh\ntouch monitor-executed\n").unwrap();
        std::fs::set_permissions(&monitor, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(Command::new("git").args(["config", "core.fsmonitor"])
            .arg(&monitor).current_dir(&dir).status().unwrap().success());
        let (_, _, code) = run(dir.to_str().unwrap(), &argv(&["status", "--porcelain"]), None).unwrap();
        assert_eq!(code, 0);
        let executed = dir.join("monitor-executed").exists();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!executed, "repository fsmonitor executed outside the Session sandbox");
    }
}
