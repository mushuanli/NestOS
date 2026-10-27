use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn write(path: &Path, data: &[u8]) -> io::Result<()> {
    let (temporary, mut file) = create_temporary(path)?;
    let result = file.write_all(data);
    drop(file);
    let result = result.and_then(|_| std::fs::rename(&temporary, path));
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result
}

fn create_temporary(path: &Path) -> io::Result<(PathBuf, File)> {
    for _ in 0..32 {
        let mut name = path.as_os_str().to_os_string();
        name.push(format!(".{}.{}.tmp", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)));
        let temporary = PathBuf::from(name);
        match OpenOptions::new().write(true).create_new(true).open(&temporary) {
            Ok(file) => return Ok((temporary, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "No unused temporary file name"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    fn directory() -> PathBuf {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("nestos-atomic-{}-{stamp}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        root
    }

    #[test]
    fn concurrent_writers_publish_one_complete_value() {
        let root = directory();
        let target = root.join("same.bin");
        let barrier = Arc::new(Barrier::new(24));
        let threads: Vec<_> = (0..24u8).map(|index| {
            let target = target.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || { barrier.wait(); write(&target, &vec![index; 8192]).unwrap(); })
        }).collect();
        for thread in threads { thread.join().unwrap(); }
        let data = std::fs::read(target).unwrap();
        assert_eq!(data.len(), 8192);
        assert!(data.iter().all(|byte| *byte == data[0]));
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_publication_preserves_destination_and_removes_temporary_file() {
        let root = directory();
        let target = root.join("directory");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep"), b"original").unwrap();
        assert!(write(&target, b"replacement").is_err());
        assert_eq!(std::fs::read(target.join("keep")).unwrap(), b"original");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
