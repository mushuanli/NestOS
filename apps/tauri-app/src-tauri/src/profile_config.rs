use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "nestos.json";
const DEFAULT_SETTINGS: &str = include_str!("../../../../backend/app-core/src/profile/default-profile.json");

pub fn config_dir(home: &Path, xdg: Option<PathBuf>) -> PathBuf {
    let base = xdg.unwrap_or_else(|| home.join(".config"));
    let current = base.join("nestos");
    let legacy = base.join("mindos");
    if !current.join(FILE_NAME).exists() && legacy.join("mindos.json").exists() { legacy } else { current }
}

pub fn settings_file(directory: &Path) -> PathBuf {
    let current = directory.join(FILE_NAME);
    let legacy = directory.join("mindos.json");
    if !current.exists() && legacy.exists() { legacy } else { current }
}

/// Exclusive creation preserves existing settings, including concurrent first launches.
pub fn ensure_settings(directory: &Path) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    match OpenOptions::new().write(true).create_new(true).open(settings_file(directory)) {
        Ok(mut file) => file.write_all(DEFAULT_SETTINGS.as_bytes()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xdg_and_default_config_roots_match_cli() {
        assert_eq!(config_dir(Path::new("/home/me"), None), Path::new("/home/me/.config/nestos"));
        assert_eq!(config_dir(Path::new("/home/me"), Some(PathBuf::from("/custom"))), Path::new("/custom/nestos"));
    }

    #[test]
    fn creates_defaults_without_replacing_existing_data_or_config() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("nestos-profile-{}-{stamp}", std::process::id()));
        fs::create_dir_all(root.join("data")).unwrap();
        fs::write(root.join("data/keep"), "existing data").unwrap();
        ensure_settings(&root).unwrap();
        assert_eq!(fs::read_to_string(root.join(FILE_NAME)).unwrap(), DEFAULT_SETTINGS);
        fs::write(root.join(FILE_NAME), "custom settings").unwrap();
        ensure_settings(&root).unwrap();
        assert_eq!(fs::read_to_string(root.join(FILE_NAME)).unwrap(), "custom settings");
        assert_eq!(fs::read_to_string(root.join("data/keep")).unwrap(), "existing data");
        fs::remove_dir_all(root).unwrap();
    }
}
