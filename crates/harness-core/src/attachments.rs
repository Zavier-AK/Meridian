//! Images the person attaches to a message for the head agent.
//!
//! The head agent sees each image itself, inline in the message. Workers can't (each
//! sees only its task text), so every image is also saved under the project's
//! `.harness/attachments/`, which is git-excluded, and the head agent is given the path to
//! put in a task brief. A worker reads it with its own file tools; the path is absolute
//! because a worker runs in its own worktree, where `.harness/` does not exist.

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// At most this many images per message.
pub const MAX_IMAGES: usize = 6;
/// The API refuses images over 5 MB; stay under it.
pub const MAX_BYTES: usize = 5 * 1024 * 1024 - 64 * 1024;

/// One image as the UI sends it: base64 without a `data:` prefix.
#[derive(Debug, Clone, Deserialize)]
pub struct ImageInput {
    pub media_type: String,
    pub data: String,
}

/// A checked image, saved where workers can read it.
#[derive(Debug, Clone)]
pub struct Image {
    pub media_type: &'static str,
    /// Base64, as sent to the model.
    pub data: String,
    pub path: PathBuf,
}

/// The type the bytes really are, from their first bytes, whatever was claimed.
fn sniff(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => Some(("image/png", "png")),
        [0xFF, 0xD8, 0xFF, ..] => Some(("image/jpeg", "jpg")),
        [b'G', b'I', b'F', b'8', ..] => Some(("image/gif", "gif")),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => {
            Some(("image/webp", "webp"))
        }
        _ => None,
    }
}

/// Check each image and save it under `<project>/.harness/attachments/`.
pub fn save(project_root: &Path, inputs: &[ImageInput]) -> Result<Vec<Image>> {
    if inputs.len() > MAX_IMAGES {
        bail!("at most {MAX_IMAGES} images per message");
    }
    // Absolute, whatever the caller passed: a worker in its own worktree must be able
    // to open the path as written.
    let root = std::fs::canonicalize(project_root).unwrap_or_else(|_| project_root.to_path_buf());
    let dir = root.join(".harness").join("attachments");
    let mut images = Vec::new();
    for input in inputs.iter() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(input.data.trim())
            .context("an attached image isn't valid base64")?;
        if bytes.len() > MAX_BYTES {
            bail!(
                "an attached image is {:.1} MB; the limit is 5 MB",
                bytes.len() as f64 / 1_048_576.0
            );
        }
        let Some((media_type, ext)) = sniff(&bytes) else {
            bail!("an attachment isn't a PNG, JPEG, GIF or WebP image");
        };
        std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
        let filename = format!("{}.{ext}", Uuid::new_v4());
        let path = dir.join(&filename);
        std::fs::write(&path, &bytes).with_context(|| format!("saving {}", path.display()))?;
        images.push(Image {
            media_type,
            data: input.data.trim().to_string(),
            path,
        });
    }
    Ok(images)
}

/// The note that rides with the message, so the head agent can hand an image on.
pub fn note(images: &[Image]) -> String {
    if images.is_empty() {
        return String::new();
    }
    let paths: Vec<String> = images
        .iter()
        .map(|i| format!("- {}", i.path.display()))
        .collect();
    format!(
        "\n\n<attachments>\nThe person attached {} image{} (shown above). Workers can't see \
         them unless you pass the path in the task brief and tell them to open it with \
         their Read tool:\n{}\n</attachments>",
        images.len(),
        if images.len() == 1 { "" } else { "s" },
        paths.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    #[test]
    fn an_image_is_checked_saved_and_pointed_to() {
        let dir = tempfile::tempdir().unwrap();
        let images = save(
            dir.path(),
            &[ImageInput {
                media_type: "image/jpeg".into(),
                data: PNG_1X1.into(),
            }],
        )
        .unwrap();
        assert_eq!(images.len(), 1);
        // The bytes decide the type, not the claim.
        assert_eq!(images[0].media_type, "image/png");
        let root = std::fs::canonicalize(dir.path()).unwrap();
        assert!(images[0]
            .path
            .starts_with(root.join(".harness/attachments")));
        assert!(images[0].path.is_absolute());
        assert!(images[0].path.exists());
        let note = note(&images);
        assert!(note.contains(&images[0].path.display().to_string()));
        assert!(note.contains("Read tool"));
    }

    #[test]
    fn two_saves_at_once_never_share_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let one = || ImageInput {
            media_type: "image/png".into(),
            data: PNG_1X1.into(),
        };
        let first = save(dir.path(), &[one(), one()]).unwrap();
        let second = save(dir.path(), &[one()]).unwrap();
        let paths: std::collections::HashSet<_> = first
            .iter()
            .chain(&second)
            .map(|i| i.path.clone())
            .collect();
        assert_eq!(paths.len(), 3, "every image gets its own file");
        assert!(paths.iter().all(|p| p.exists()));
    }

    #[test]
    fn the_saved_path_is_absolute_even_from_a_relative_project() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir(&project).unwrap();
        // A relative path, as the CLI passes `.`: resolved against the process's cwd.
        let relative = pathdiff(&project);
        let saved = save(
            &relative,
            &[ImageInput {
                media_type: "image/png".into(),
                data: PNG_1X1.into(),
            }],
        )
        .unwrap();
        assert!(saved[0].path.is_absolute(), "{}", saved[0].path.display());
    }

    /// `path` relative to the current directory, by enough `..` to reach the root.
    fn pathdiff(path: &Path) -> PathBuf {
        let cwd = std::env::current_dir().unwrap();
        let mut rel = PathBuf::new();
        for _ in cwd.components().skip(1) {
            rel.push("..");
        }
        rel.join(path.strip_prefix("/").unwrap())
    }

    #[test]
    fn what_isnt_an_image_or_is_too_much_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let text = base64::engine::general_purpose::STANDARD.encode(b"<script>alert(1)</script>");
        assert!(save(
            dir.path(),
            &[ImageInput {
                media_type: "image/png".into(),
                data: text
            }]
        )
        .is_err());
        assert!(save(
            dir.path(),
            &[ImageInput {
                media_type: "image/png".into(),
                data: "!!".into()
            }]
        )
        .is_err());
        let many: Vec<ImageInput> = (0..MAX_IMAGES + 1)
            .map(|_| ImageInput {
                media_type: "image/png".into(),
                data: PNG_1X1.into(),
            })
            .collect();
        assert!(save(dir.path(), &many).is_err());
        let huge = base64::engine::general_purpose::STANDARD
            .encode([&[0x89u8, b'P', b'N', b'G'][..], &vec![0u8; MAX_BYTES]].concat());
        assert!(save(
            dir.path(),
            &[ImageInput {
                media_type: "image/png".into(),
                data: huge
            }]
        )
        .is_err());
        assert!(note(&[]).is_empty());
    }
}
