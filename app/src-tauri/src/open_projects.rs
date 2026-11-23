//! Which projects were open, and which was in front, so the next launch puts them back.
//!
//! Without this every launch opened only Home, and a project's conversation (kept in its
//! own `.harness/sessions.db`) was out of sight until the project was opened again by
//! hand: it looked as if the chats were gone. Home itself is never listed; it always
//! opens.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FILE: &str = "open-projects.json";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct OpenProjects {
    /// Canonical project paths, in the order they were opened.
    pub projects: Vec<String>,
    /// The one in front, if it was a project rather than Home.
    pub active: Option<String>,
}

impl OpenProjects {
    /// What to remember now: the earlier order kept for what's still open, anything newly
    /// opened added at the end, anything closed dropped.
    pub fn updated(self, open: &[String], active: Option<String>) -> Self {
        let mut projects: Vec<String> = self
            .projects
            .into_iter()
            .filter(|p| open.contains(p))
            .collect();
        for p in open {
            if !projects.contains(p) {
                projects.push(p.clone());
            }
        }
        let active = active.filter(|a| projects.contains(a));
        Self { projects, active }
    }
}

pub fn path() -> Option<PathBuf> {
    Some(harness_core::extensions::app_data_dir()?.join(FILE))
}

/// Missing or unreadable means nothing to reopen: never a reason not to start.
pub fn load_from(path: &Path) -> OpenProjects {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_to(path: &Path, open: &OpenProjects) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let text = serde_json::to_string_pretty(open).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn keeps_the_order_drops_what_closed_and_adds_what_opened() {
        let before = OpenProjects {
            projects: strings(&["/a", "/b", "/c"]),
            active: Some("/b".into()),
        };
        // /b closed, /d opened; the map they come from has no order of its own.
        let after = before.updated(&strings(&["/d", "/c", "/a"]), Some("/d".into()));
        assert_eq!(after.projects, strings(&["/a", "/c", "/d"]));
        assert_eq!(after.active.as_deref(), Some("/d"));
    }

    #[test]
    fn home_in_front_or_a_closed_project_is_no_project_in_front() {
        let open = strings(&["/a"]);
        let home = OpenProjects::default().updated(&open, Some("/Users/me/Meridian Home".into()));
        assert_eq!(home.active, None);
        let none = OpenProjects::default().updated(&open, None);
        assert_eq!(none.active, None);
    }

    #[test]
    fn round_trips_and_survives_a_missing_or_broken_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        assert_eq!(load_from(&path), OpenProjects::default());
        let open = OpenProjects {
            projects: strings(&["/a", "/b"]),
            active: Some("/a".into()),
        };
        save_to(&path, &open).unwrap();
        assert_eq!(load_from(&path), open);
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(load_from(&path), OpenProjects::default());
    }
}
