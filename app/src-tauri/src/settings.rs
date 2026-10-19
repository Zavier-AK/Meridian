//! App-wide preferences from the Settings tab, kept as JSON in the app's data folder.
//!
//! Per-project choices (the fleet, its tools) stay in each project's `roles.toml`; this
//! holds only what applies to the app as a whole.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FILE: &str = "settings.json";
/// The OpenRouter key, kept apart from the settings so it never travels with them.
const OPENROUTER_KEY_FILE: &str = "openrouter.key";
/// How many OpenRouter models the fleet editor offers; its catalog runs to hundreds.
const MAX_OPENROUTER_MODELS: usize = 40;

/// The type pairings the app bundles (see `fonts.ts`). The first is the default.
pub const FONTS: &[&str] = &["grotesk", "geist", "plex", "editorial", "manrope", "system"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// The head agent's model when a project is opened without choosing one. `None`
    /// leaves it to the Claude CLI's own default.
    pub default_model: Option<String>,
    /// The head agent's turn limit — the runaway-loop rail for a whole conversation.
    pub max_turns: u32,
    /// Notify when a worker finishes or a merge waits, while the window is in the back.
    pub notifications: bool,
    /// Accent colour as `#rrggbb`. `None` keeps the theme's own.
    pub accent: Option<String>,
    /// The type pairing, one of [`FONTS`].
    pub font: String,
    /// Push-to-talk.
    pub voice: crate::voice::VoiceSettings,
    /// OpenRouter models offered when a role is reassigned, e.g. `qwen/qwen3-coder`.
    pub openrouter_models: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            default_model: None,
            max_turns: 200,
            notifications: true,
            accent: None,
            font: FONTS[0].to_string(),
            voice: crate::voice::VoiceSettings::default(),
            openrouter_models: Vec::new(),
        }
    }
}

impl Settings {
    /// Normalize, and refuse what would break a session rather than store it.
    pub fn validated(mut self) -> Result<Self, String> {
        self.default_model = self
            .default_model
            .map(|model| model.trim().to_string())
            .filter(|model| !model.is_empty());
        if let Some(model) = &self.default_model {
            // Never starting with `-`: it is passed as the value of `--model`, and must not
            // be mistaken for a flag of its own.
            let valid = model.len() <= 100
                && !model.starts_with('-')
                && model.chars().all(|c| {
                    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '[' | ']' | '/')
                });
            if !valid {
                return Err(format!("`{model}` does not look like a model name"));
            }
        }
        if !(1..=1000).contains(&self.max_turns) {
            return Err("max turns must be between 1 and 1000".into());
        }
        self.accent = self.accent.filter(|accent| !accent.is_empty());
        if let Some(accent) = &self.accent {
            let valid = accent.len() == 7
                && accent.starts_with('#')
                && accent[1..].chars().all(|c| c.is_ascii_hexdigit());
            if !valid {
                return Err(format!("`{accent}` is not a #rrggbb colour"));
            }
        }
        self.font = self.font.trim().to_lowercase();
        if !FONTS.contains(&self.font.as_str()) {
            return Err(format!(
                "`{}` isn't one of the fonts: {}",
                self.font,
                FONTS.join(", ")
            ));
        }
        self.voice = self.voice.validated()?;
        let mut models: Vec<String> = Vec::new();
        for model in self.openrouter_models.iter().map(|m| m.trim()) {
            if model.is_empty() || models.iter().any(|m| m == model) {
                continue;
            }
            if !harness_core::openrouter::valid_slug(model) {
                return Err(format!(
                    "`{model}` isn't an OpenRouter model id — they look like vendor/model"
                ));
            }
            models.push(model.to_string());
        }
        if models.len() > MAX_OPENROUTER_MODELS {
            return Err(format!(
                "at most {MAX_OPENROUTER_MODELS} OpenRouter models can be offered"
            ));
        }
        self.openrouter_models = models;
        Ok(self)
    }
}

pub fn path() -> Option<PathBuf> {
    Some(harness_core::extensions::app_data_dir()?.join(FILE))
}

/// A missing or unreadable file means defaults: settings are never a reason not to start.
pub fn load_from(path: &Path) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .and_then(|settings| settings.validated().ok())
        .unwrap_or_default()
}

pub fn load() -> Settings {
    path().map(|path| load_from(&path)).unwrap_or_default()
}

pub fn save_to(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn openrouter_key_path() -> Option<PathBuf> {
    Some(harness_core::extensions::app_data_dir()?.join(OPENROUTER_KEY_FILE))
}

pub fn load_openrouter_key() -> Option<String> {
    openrouter_key_path().and_then(|path| load_key_from(&path))
}

pub fn save_openrouter_key(key: Option<&str>) -> Result<(), String> {
    let path = openrouter_key_path().ok_or("no home directory to keep the key in")?;
    save_key_to(&path, key)
}

fn load_key_from(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|key| !key.is_empty())
}

/// Readable by this user alone. `None` removes it.
fn save_key_to(path: &Path, key: Option<&str>) -> Result<(), String> {
    let Some(key) = key else {
        return match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    };
    let key = key.trim();
    let plausible = !key.is_empty()
        && key.len() <= 300
        && key.chars().all(|c| c.is_ascii_graphic());
    if !plausible {
        return Err("that doesn't look like an API key".into());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("key.{}.tmp", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    {
        use std::io::Write;
        let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
        file.write_all(key.as_bytes()).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_or_broken_file_means_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            load_from(&dir.path().join("none.json")),
            Settings::default()
        );
        std::fs::write(dir.path().join("bad.json"), "{ not json").unwrap();
        assert_eq!(load_from(&dir.path().join("bad.json")), Settings::default());
    }

    #[test]
    fn settings_round_trip_and_fill_in_missing_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        let settings = Settings {
            default_model: Some("opus".into()),
            max_turns: 80,
            notifications: false,
            accent: Some("#e0567a".into()),
            font: "plex".into(),
            voice: crate::voice::VoiceSettings {
                enabled: true,
                confidence: 0.8,
                ..Default::default()
            },
            openrouter_models: vec!["qwen/qwen3-coder".into()],
        };
        save_to(&path, &settings).unwrap();
        assert_eq!(load_from(&path), settings);

        // A file from an older version, missing newer fields, still loads.
        std::fs::write(&path, r#"{"max_turns": 50}"#).unwrap();
        let loaded = load_from(&path);
        assert_eq!(loaded.max_turns, 50);
        assert!(loaded.notifications);
    }

    #[test]
    fn values_that_would_break_a_session_are_refused() {
        let bad = [
            Settings {
                max_turns: 0,
                ..Default::default()
            },
            Settings {
                max_turns: 5000,
                ..Default::default()
            },
            Settings {
                accent: Some("red".into()),
                ..Default::default()
            },
            Settings {
                font: "comic-sans".into(),
                ..Default::default()
            },
            Settings {
                default_model: Some("--dangerously-skip".into()),
                ..Default::default()
            },
            Settings {
                default_model: Some("has space".into()),
                ..Default::default()
            },
            Settings {
                openrouter_models: vec!["--model".into()],
                ..Default::default()
            },
            Settings {
                openrouter_models: vec!["no-vendor".into()],
                ..Default::default()
            },
        ];
        for settings in bad {
            assert!(settings.clone().validated().is_err(), "{settings:?}");
        }
        let blank = Settings {
            default_model: Some("  ".into()),
            ..Default::default()
        };
        assert_eq!(blank.validated().unwrap().default_model, None);

        let models = Settings {
            openrouter_models: vec![
                " qwen/qwen3-coder ".into(),
                "qwen/qwen3-coder".into(),
                "".into(),
            ],
            ..Default::default()
        };
        assert_eq!(
            models.validated().unwrap().openrouter_models,
            ["qwen/qwen3-coder"]
        );
    }

    #[test]
    fn the_openrouter_key_is_kept_private_and_can_be_removed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(OPENROUTER_KEY_FILE);
        assert_eq!(load_key_from(&path), None);

        save_key_to(&path, Some("  sk-or-v1-abc \n")).unwrap();
        assert_eq!(load_key_from(&path).as_deref(), Some("sk-or-v1-abc"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        assert!(save_key_to(&path, Some("has space")).is_err());
        assert!(save_key_to(&path, Some("")).is_err());

        save_key_to(&path, None).unwrap();
        assert_eq!(load_key_from(&path), None);
        // Removing what isn't there is fine.
        save_key_to(&path, None).unwrap();
    }
}
