use std::process::{Command, Stdio};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub type OutputSink = std::sync::Arc<dyn Fn(&'static str, &[u8]) + Send + Sync>;

const MAX_CAPTURE_BYTES: usize = 1024 * 1024;
const TRUNCATED: &str = "\n[Bash output truncated at 1048576 bytes]";

#[cfg(test)]
pub fn execute(script: &str, cwd: &str, timeout_ms: u64, cancelled: &AtomicBool) -> Result<(String, String, i32), String> {
    execute_command(command(script, cwd), timeout_ms, cancelled)
}

pub fn execute_command(command: Command, timeout_ms: u64, cancelled: &AtomicBool) -> Result<(String, String, i32), String> {
    execute_streamed(command, timeout_ms, cancelled, None)
}

pub fn execute_streamed(mut command: Command, timeout_ms: u64, cancelled: &AtomicBool, output: Option<OutputSink>) -> Result<(String, String, i32), String> {
    if timeout_ms == 0 || timeout_ms > 2147483647 { return Err("Invalid Bash timeout".into()); }
    if cancelled.load(Ordering::SeqCst) { return Err("Bash command cancelled before start".into()); }
    let mut child = command.spawn().map_err(|e| format!("bash exec failed: {e}"))?;
    let stdout = read_pipe(child.stdout.take(), "stdout", output.clone());
    let stderr = read_pipe(child.stderr.take(), "stderr", output);
    let status = wait(&mut child, timeout_ms, cancelled);
    // One-shot execution owns its entire group, including inherited output pipes.
    signal_group(child.id(), "-KILL");
    let _ = child.kill();
    let _ = child.wait();
    #[cfg(target_os = "linux")]
    wait_group_stopped(child.id());
    let output = stdout.join().map_err(|_| "Bash stdout reader failed")??;
    let errors = stderr.join().map_err(|_| "Bash stderr reader failed")??;
    Ok((output, errors, status?.code().unwrap_or(-1)))
}

fn wait(child: &mut std::process::Child, timeout_ms: u64, cancelled: &AtomicBool) -> Result<std::process::ExitStatus, String> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { return Ok(status); }
        if cancelled.load(Ordering::SeqCst) || Instant::now() >= deadline {
            signal_group(child.id(), "-TERM");
            std::thread::sleep(Duration::from_millis(100));
            signal_group(child.id(), "-KILL");
            let _ = child.kill();
            return child.wait().map_err(|e| e.to_string());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn signal_group(pid: u32, signal: &str) {
    #[cfg(unix)]
    { let _ = Command::new("kill").args([signal, "--", &format!("-{pid}")]).stdout(Stdio::null()).stderr(Stdio::null()).status(); }
    #[cfg(not(unix))]
    { let _ = (pid, signal); }
}

#[cfg(target_os = "linux")]
pub(crate) fn wait_group_stopped(group: u32) {
    let mut reported = false;
    loop {
        signal_group(group, "-KILL");
        match group_active(group) {
            Ok(false) => return,
            Ok(true) => {},
            Err(error) if !reported => {
                eprintln!("Process cleanup is awaiting confirmation: {error}");
                reported = true;
            },
            Err(_) => {},
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(target_os = "linux")]
fn group_active(group: u32) -> std::io::Result<bool> {
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().parse::<u32>().is_err() { continue; }
        let stat = match std::fs::read_to_string(entry.path().join("stat")) {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let fields: Vec<_> = stat.rsplit_once(')').ok_or_else(|| std::io::Error::new(
            std::io::ErrorKind::InvalidData, "Invalid process stat"))?.1.split_whitespace().collect();
        if fields.get(2).and_then(|value| value.parse::<u32>().ok()) == Some(group)
            && !matches!(fields.first(), Some(&"Z") | Some(&"X")) { return Ok(true); }
    }
    Ok(false)
}

fn read_pipe<T: Read + Send + 'static>(pipe: Option<T>, stream: &'static str, output: Option<OutputSink>) -> std::thread::JoinHandle<Result<String, String>> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut truncated = false;
        if let Some(mut pipe) = pipe {
            let mut chunk = [0u8; 8192];
            loop {
                let count = match pipe.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(count) => count,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(format!("Bash output read failed: {error}")),
                };
                let retained = count.min(MAX_CAPTURE_BYTES - bytes.len());
                bytes.extend_from_slice(&chunk[..retained]);
                if retained > 0 { if let Some(ref output) = output { output(stream, &chunk[..retained]); } }
                truncated |= retained < count;
                // Keep draining after the limit so the child cannot block on a full pipe.
            }
        }
        let mut output = String::from_utf8_lossy(&bytes).into_owned();
        if truncated { output.push_str(TRUNCATED); }
        Ok(output)
    })
}

pub fn command(script: &str, cwd: &str) -> Command {
    let mut command = Command::new("bash");
    command.args(["--noprofile", "--norc", "-c", script])
        .env_remove("BASH_ENV")
        .current_dir(cwd)
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

    #[test]
    fn emits_output_before_command_completion() {
        let (send, receive) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || execute_streamed(command("printf first; sleep 0.2; printf second", "/tmp"), 5000,
            &AtomicBool::new(false), Some(std::sync::Arc::new(move |stream, bytes| { send.send((stream, bytes.to_vec())).unwrap(); }))));
        let first = receive.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(first, ("stdout", b"first".to_vec())); assert!(!worker.is_finished());
        let result = worker.join().unwrap().unwrap(); assert_eq!(result.0, "firstsecond");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn waits_for_background_members_without_output_pipes() {
        let root = std::env::temp_dir().join(format!("bash-background-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let script = "bash -c 'trap \"\" TERM; echo $$ > pid; while :; do sleep 1; done' >/dev/null 2>&1 & while [ ! -f pid ]; do sleep 0.01; done";
        execute(script, root.to_str().unwrap(), 5_000, &AtomicBool::new(false)).unwrap();
        let pid = std::fs::read_to_string(root.join("pid")).unwrap();
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{}/stat", pid.trim())) {
            let state = stat.rsplit_once(')').unwrap().1.split_whitespace().next().unwrap();
            assert!(state == "Z" || state == "X", "background member can still execute: {stat}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn executes_bash_syntax_and_preserves_streams_and_exit_status() {
        let cwd = std::env::temp_dir();
        let result = command("items=(first second); printf '%s' \"${items[1]}\"; printf 'diagnostic' >&2; exit 7", cwd.to_str().unwrap())
            .output().unwrap();
        assert_eq!(result.stdout, b"second");
        assert_eq!(result.stderr, b"diagnostic");
        assert_eq!(result.status.code(), Some(7));
    }

    #[test]
    fn runs_nested_bash_in_the_requested_directory() {
        let cwd = std::env::temp_dir();
        let result = command("bash --noprofile --norc -c 'printf \"%s\" \"$PWD\"'", cwd.to_str().unwrap())
            .output().unwrap();
        assert!(result.status.success());
        assert_eq!(String::from_utf8(result.stdout).unwrap(), cwd.canonicalize().unwrap().to_str().unwrap());
    }

    #[test]
    fn timeout_stops_children_that_ignore_term_and_closes_their_pipes() {
        let start = Instant::now();
        let result = execute("trap '' TERM; bash -c 'trap \"\" TERM; while :; do sleep 1; done' & wait",
            std::env::temp_dir().to_str().unwrap(), 50, &AtomicBool::new(false)).unwrap();
        assert_eq!(result.2, -1);
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn bounds_both_streams_while_draining_large_child_output() {
        let script = format!("head -c {} /dev/zero; head -c {} /dev/zero >&2; exit 7",
            MAX_CAPTURE_BYTES * 2, MAX_CAPTURE_BYTES * 2);
        let result = execute(&script, std::env::temp_dir().to_str().unwrap(), 5_000, &AtomicBool::new(false)).unwrap();
        assert_eq!(result.2, 7);
        for output in [result.0, result.1] {
            assert_eq!(output.len(), MAX_CAPTURE_BYTES + TRUNCATED.len());
            assert!(output.ends_with(TRUNCATED));
        }
    }

    #[test]
    fn a_missing_isolator_fails_the_command_instead_of_running_unescaped() {
        // Stands in for a host without bubblewrap (non-Linux or a stripped runtime): the only
        // program the session shell can spawn is the namespace builder, so the command must
        // fail closed — never silently run in the host environment.
        let mut command = Command::new("nestos-missing-isolator");
        command.arg("--").arg("bash").arg("-c").arg("echo leaked");
        let error = execute_command(command, 5_000, &AtomicBool::new(false)).unwrap_err();
        assert!(error.contains("bash exec failed"), "{error}");
    }

    #[test]
    fn leaves_small_output_unchanged() {
        let result = execute("printf hello; printf error >&2", std::env::temp_dir().to_str().unwrap(),
            5_000, &AtomicBool::new(false)).unwrap();
        assert_eq!(result, ("hello".into(), "error".into(), 0));
    }

    #[test]
    fn cancellation_stops_a_running_process_group() {
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let signal = cancelled.clone();
        let setter = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            signal.store(true, Ordering::SeqCst);
        });
        let start = Instant::now();
        let result = execute("sleep 30 & wait", std::env::temp_dir().to_str().unwrap(), 30_000, &cancelled).unwrap();
        setter.join().unwrap();
        assert_eq!(result.2, -1);
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
