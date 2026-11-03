//! Notes: what Meridian's agents learn in one project, available in the next.
//!
//! A plain folder of markdown — Obsidian opens it as a vault, but nothing here needs
//! Obsidian:
//!
//! ```text
//! me.md                 who the person is, how they work: theirs to write
//! projects/<name>.md    one per project: what it is, decisions, conventions, open threads
//! topics/<name>.md      know-how that outlives a project: "tauri-gotchas", "auth-approach"
//! ```
//!
//! The rule throughout is that less context is usually better. Only two small things are
//! given to the head agent up front, each capped: the person's `me.md` and this project's
//! own note. Everything else is looked up with [`Notes::search`], which returns snippets,
//! not files; the head agent reads a whole note only when a snippet earns it, and passes a
//! worker only the lines its task needs. Workers get nothing by default.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

pub const ME: &str = "me.md";
pub const PROJECTS: &str = "projects";
pub const TOPICS: &str = "topics";

/// The most of `me.md` the head agent is given: about 500 tokens.
const ME_CAP: usize = 2_000;
/// The most of the project's note it is given: about 750 tokens.
const PROJECT_CAP: usize = 3_000;
/// What one read returns at most.
const READ_CAP: usize = 12_000;
/// What one note may hold. A note this long has stopped being a note.
const WRITE_CAP: usize = 16_000;
const SNIPPET: usize = 220;
/// How well a note must match a message to be pointed out unasked: more than a stray
/// shared word, roughly a title match plus some of the body.
const RECALL_MIN: u32 = 8;
/// At most this many pointed out with one message.
const RECALL_MAX: usize = 3;

const ME_TEMPLATE: &str = "# About me\n\n\
<!-- Meridian gives this to every project's head agent, so keep it short: the things you'd \
otherwise repeat in every project. Anything past about 2,000 characters is cut off. -->\n\n\
## How I work\n\n\
## My stack\n\n\
## Always / never\n";

const README: &str = "# Meridian notes\n\n\
What Meridian's agents have learned, kept between projects. Plain markdown: edit, move or \
delete anything. Open this folder as an Obsidian vault if you like.\n\n\
- `me.md` is yours: about you and how you work. Agents read it, never write it.\n\
- `projects/` has a note per project: decisions, conventions, open threads.\n\
- `topics/` has know-how that's useful beyond one project.\n\n\
Agents look notes up when they're relevant; only `me.md` and the current project's note are \
given to them up front, and only the first part of each.\n";

/// A note in the folder, for listing.
#[derive(Debug, Clone, Serialize)]
pub struct NoteInfo {
    /// Relative to the folder, with `/`.
    pub path: String,
    pub title: String,
    /// Unix seconds.
    pub modified: i64,
    pub bytes: u64,
}

/// One search result: where, and enough to decide whether to read it.
#[derive(Debug, Clone, Serialize)]
pub struct Hit {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub score: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode {
    Replace,
    Append,
}

/// What a write did, for the person to see.
#[derive(Debug, Clone, Serialize)]
pub struct Written {
    pub path: String,
    pub created: bool,
    pub bytes: usize,
}

#[derive(Debug, Clone)]
pub struct Notes {
    root: PathBuf,
}

impl Notes {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// The default folder: `~/Documents/Meridian Notes`.
    pub fn default_root() -> Option<PathBuf> {
        let home = std::env::var_os("HOME").map(PathBuf::from)?;
        Some(home.join("Documents").join("Meridian Notes"))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Make the folder and its starting files, leaving anything already there alone.
    pub fn ensure(&self) -> Result<()> {
        for dir in [PROJECTS, TOPICS] {
            std::fs::create_dir_all(self.root.join(dir))
                .with_context(|| format!("making {}", self.root.join(dir).display()))?;
        }
        for (name, body) in [(ME, ME_TEMPLATE), ("README.md", README)] {
            let path = self.root.join(name);
            if !path.exists() {
                std::fs::write(&path, body)?;
            }
        }
        Ok(())
    }

    /// A project's note, by its folder's name: `projects/calendar-system.md`.
    pub fn project_note(project_root: &Path) -> String {
        let name = project_root
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let slug: String = name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>()
            .split('-')
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        format!(
            "{PROJECTS}/{}.md",
            if slug.is_empty() { "project" } else { &slug }
        )
    }

    /// The notes section of the head agent's brief: how to use them, plus `me.md` and
    /// this project's note, each cut to its cap. A section with nothing in it is left out.
    pub fn head_context(&self, project_root: &Path) -> String {
        let project = Self::project_note(project_root);
        let mut out = format!(
            "\n\nNotes from earlier work, here and in other projects, are in a notes folder \
             you reach with the notes tools. Less context is usually better, so:\n\
             - Before non-trivial or unfamiliar work, `notes_search` it. Read a note in full \
             only when its snippet is clearly relevant.\n\
             - Give a worker only the lines of a note its task needs, in its brief. Never \
             paste whole notes.\n\
             - When a decision, convention or gotcha comes up that a later session would need, \
             record it with `notes_write`: this project's in `{project}`, know-how that \
             applies elsewhere in `topics/<topic>.md`. Write a few lines, not a transcript. \
             Edit what's there rather than adding duplicates. Keep a project note under a \
             page. Don't write what the code or git history already says.\n\
             - `me.md` is the person's; read it, never write it."
        );
        if let Some(me) = self.read_meaningful(ME) {
            out.push_str("\n\nAbout the person (me.md):\n");
            out.push_str(&cut(&me, ME_CAP));
        }
        match self.read_meaningful(&project) {
            Some(note) => {
                out.push_str(&format!("\n\nThis project's note ({project}):\n"));
                out.push_str(&cut(&note, PROJECT_CAP));
            }
            None => out.push_str(&format!(
                "\n\nThis project has no note yet. Start `{project}` once there's something \
                 worth keeping: what the project is, and decisions made."
            )),
        }
        out
    }

    /// A note's text, if it says anything beyond headings and comments.
    fn read_meaningful(&self, relative: &str) -> Option<String> {
        let text = std::fs::read_to_string(self.root.join(relative)).ok()?;
        has_content(&text).then_some(text)
    }

    pub fn list(&self) -> Vec<NoteInfo> {
        let mut notes = Vec::new();
        let mut stack = vec![PathBuf::new()];
        while let Some(relative) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(self.root.join(&relative)) else {
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let path = relative.join(&name);
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                if kind.is_dir() && relative.components().count() < 3 {
                    stack.push(path);
                } else if kind.is_file() && name.ends_with(".md") {
                    let meta = entry.metadata().ok();
                    let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
                    notes.push(NoteInfo {
                        path: slash(&path),
                        title: title_of(&text, &name),
                        modified: meta
                            .as_ref()
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as i64)
                            .unwrap_or(0),
                        bytes: meta.map(|m| m.len()).unwrap_or(0),
                    });
                }
            }
        }
        notes.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.path.cmp(&b.path)));
        notes
    }

    /// The notes that best match `query`, best first, as snippets.
    pub fn search(&self, query: &str, limit: usize) -> Vec<Hit> {
        let terms = terms(query);
        if terms.is_empty() {
            return Vec::new();
        }
        let mut hits: Vec<(Hit, i64)> = self
            .list()
            .into_iter()
            .filter(|n| n.path != "README.md")
            .filter_map(|note| {
                let text = std::fs::read_to_string(self.root.join(&note.path)).ok()?;
                if !has_content(&text) {
                    return None;
                }
                let (score, snippet) = score(&note, &text, &terms);
                (score > 0).then(|| {
                    (
                        Hit {
                            path: note.path.clone(),
                            title: note.title.clone(),
                            snippet,
                            score,
                        },
                        note.modified,
                    )
                })
            })
            .collect();
        hits.sort_by(|a, b| b.0.score.cmp(&a.0.score).then(b.1.cmp(&a.1)));
        hits.into_iter()
            .take(limit.clamp(1, 20))
            .map(|(h, _)| h)
            .collect()
    }

    /// Notes worth pointing out with a message, before the head agent has thought to look:
    /// strong matches only, never ones already pointed out this session, and never the
    /// two it was given up front.
    pub fn recall(
        &self,
        message: &str,
        project_root: &Path,
        already: &std::collections::HashSet<String>,
    ) -> Vec<Hit> {
        let own = Self::project_note(project_root);
        self.search(message, 10)
            .into_iter()
            .filter(|hit| hit.score >= RECALL_MIN)
            .filter(|hit| hit.path != own && hit.path != ME && !already.contains(&hit.path))
            .take(RECALL_MAX)
            .collect()
    }

    /// The few lines that carry recalled notes with a message.
    pub fn recall_block(hits: &[Hit]) -> String {
        let mut out = String::from(
            "\n\n<notes-recall>\nNotes from earlier work that may bear on this. Read one with \
             notes_read if it matters, and give a worker only what applies:",
        );
        for hit in hits {
            out.push_str(&format!(
                "\n- {} ({}): {}",
                hit.path, hit.title, hit.snippet
            ));
        }
        out.push_str("\n</notes-recall>");
        out
    }

    /// A note, cut off past what one read should carry.
    pub fn read(&self, relative: &str) -> Result<String> {
        let path = self.resolve(relative)?;
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("there's no note `{relative}`"))?;
        Ok(cut(&text, READ_CAP))
    }

    /// An agent's write: only under `projects/` or `topics/`, never the person's `me.md`.
    pub fn write_as_agent(
        &self,
        relative: &str,
        content: &str,
        mode: WriteMode,
    ) -> Result<Written> {
        let first = Path::new(relative).components().next();
        let allowed =
            matches!(first, Some(Component::Normal(dir)) if dir == PROJECTS || dir == TOPICS);
        if !allowed {
            bail!("agents write notes under {PROJECTS}/ or {TOPICS}/ only; `{relative}` isn't");
        }
        self.write(relative, content, mode)
    }

    /// Any note, as the person edits it.
    pub fn write(&self, relative: &str, content: &str, mode: WriteMode) -> Result<Written> {
        let path = self.resolve(relative)?;
        let existing = std::fs::read_to_string(&path).ok();
        let created = existing.is_none();
        let text = match (mode, existing) {
            (WriteMode::Append, Some(old)) => {
                let sep = if old.ends_with('\n') { "\n" } else { "\n\n" };
                format!("{old}{sep}{}\n", content.trim_end())
            }
            _ => format!("{}\n", content.trim_end()),
        };
        if text.len() > WRITE_CAP {
            bail!(
                "that would make `{relative}` {} characters; a note is at most {WRITE_CAP}. \
                 Tighten it, or split it into topics",
                text.len()
            );
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension(format!("md.{}.tmp", std::process::id()));
        std::fs::write(&tmp, &text)?;
        std::fs::rename(&tmp, &path)?;
        Ok(Written {
            path: relative.to_string(),
            created,
            bytes: text.len(),
        })
    }

    /// A `.md` path inside the folder; nothing hidden, nothing outside it.
    fn resolve(&self, relative: &str) -> Result<PathBuf> {
        let path = Path::new(relative);
        let plain = path.components().all(
            |c| matches!(c, Component::Normal(part) if !part.to_string_lossy().starts_with('.')),
        );
        if relative.is_empty() || !plain || !relative.ends_with(".md") || relative.len() > 200 {
            bail!("`{relative}` isn't a note path: something like topics/tauri-gotchas.md");
        }
        Ok(self.root.join(path))
    }
}

fn slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// The first heading, else the file name.
fn title_of(text: &str, file: &str) -> String {
    text.lines()
        .find_map(|l| l.strip_prefix("# "))
        .map(|t| t.trim().to_string())
        .unwrap_or_else(|| file.trim_end_matches(".md").replace('-', " "))
}

/// Whether a note says anything: headings and comments alone don't count.
fn has_content(text: &str) -> bool {
    let mut rest = text.to_string();
    while let Some(start) = rest.find("<!--") {
        match rest[start..].find("-->") {
            Some(end) => rest.replace_range(start..start + end + 3, ""),
            None => rest.truncate(start),
        }
    }
    rest.lines()
        .map(str::trim)
        .any(|l| !l.is_empty() && !l.starts_with('#'))
}

/// At most `max` bytes, at a line if one is near, saying it was cut.
fn cut(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let at = text[..end]
        .rfind('\n')
        .filter(|&i| i > max / 2)
        .unwrap_or(end);
    format!("{}\n[… cut here; notes_read has the rest]", &text[..at])
}

const STOP: &[&str] = &[
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "how",
    "what",
    "are",
    "was",
    "from",
    "into",
    "our",
    "you",
    "use",
    "using",
    "about",
    "please",
    "then",
    "tell",
    "came",
    "back",
    "can",
    "delegate",
    "delegated",
    "tool",
    "make",
    "want",
    "need",
    "should",
    "would",
    "could",
];

fn terms(query: &str) -> Vec<String> {
    let mut out: Vec<String> = query
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 2 && !STOP.contains(t))
        .map(str::to_string)
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Title and path matter most, then headings, then the body, each term counted a few
/// times at most so one long note can't win on repetition alone.
fn score(note: &NoteInfo, text: &str, terms: &[String]) -> (u32, String) {
    let title = format!("{} {}", note.title, note.path).to_lowercase();
    let lower = text.to_lowercase();
    let mut score = 0u32;
    let mut first: Option<usize> = None;
    for term in terms {
        let mut term_score = 0u32;
        if title.contains(term.as_str()) {
            term_score += 6;
        }
        let mut body = 0u32;
        for (i, line) in lower.lines().enumerate() {
            if line.contains(term.as_str()) {
                body += if line.trim_start().starts_with('#') {
                    3
                } else {
                    1
                };
                if first.is_none() && !line.trim_start().starts_with('#') {
                    first = Some(i);
                }
            }
        }
        term_score += body.min(6);
        score += term_score;
    }
    let lines: Vec<&str> = text.lines().collect();
    let snippet = match first {
        Some(i) => lines[i..]
            .iter()
            .take(3)
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" "),
        None => lines
            .iter()
            .map(|l| l.trim())
            .find(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("<!--"))
            .unwrap_or_default()
            .to_string(),
    };
    let snippet = if snippet.len() > SNIPPET {
        let mut end = SNIPPET;
        while !snippet.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &snippet[..end])
    } else {
        snippet
    };
    (score, snippet)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> (tempfile::TempDir, Notes) {
        let dir = tempfile::tempdir().unwrap();
        let notes = Notes::new(dir.path());
        notes.ensure().unwrap();
        (dir, notes)
    }

    #[test]
    fn a_new_folder_has_its_layout_and_an_empty_me_is_not_given_to_agents() {
        let (dir, notes) = vault();
        assert!(dir.path().join("projects").is_dir() && dir.path().join("topics").is_dir());
        assert!(dir.path().join(ME).is_file());
        let context = notes.head_context(Path::new("/code/Calendar System"));
        assert!(
            !context.contains("About the person"),
            "a template says nothing"
        );
        assert!(context.contains("projects/calendar-system.md"));
        assert!(context.contains("no note yet"));
        // A second ensure leaves what's there alone.
        std::fs::write(dir.path().join(ME), "# About me\nI like Rust.\n").unwrap();
        notes.ensure().unwrap();
        assert!(std::fs::read_to_string(dir.path().join(ME))
            .unwrap()
            .contains("Rust"));
    }

    #[test]
    fn the_head_gets_me_and_this_projects_note_cut_to_size() {
        let (dir, notes) = vault();
        std::fs::write(
            dir.path().join(ME),
            format!("# About me\n{}\n", "Prefers small PRs. ".repeat(400)),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("projects/calendar-system.md"),
            "# Calendar system\nRecurrence uses RRULE strings.\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("topics/unrelated.md"),
            "# Unrelated\nNever shown up front.\n",
        )
        .unwrap();
        let context = notes.head_context(Path::new("/x/calendar-system"));
        assert!(context.contains("Prefers small PRs"));
        assert!(context.contains("[… cut here"), "me.md is capped");
        assert!(context.contains("RRULE"));
        assert!(
            !context.contains("Never shown up front"),
            "topics are searched, not injected"
        );
        assert!(
            context.len() < ME_CAP + PROJECT_CAP + 2_000,
            "{}",
            context.len()
        );
    }

    #[test]
    fn search_returns_snippets_best_first() {
        let (dir, notes) = vault();
        std::fs::write(
            dir.path().join("topics/tauri-gotchas.md"),
            "# Tauri gotchas\n\n## Windows\nDragging needs data-tauri-drag-region on the title bar.\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("projects/site.md"),
            "# Site\nUses Next. Once had a tauri experiment.\n",
        )
        .unwrap();
        let hits = notes.search("tauri window dragging", 5);
        assert_eq!(hits[0].path, "topics/tauri-gotchas.md");
        assert!(hits[0].snippet.contains("data-tauri-drag-region"));
        assert!(hits.iter().any(|h| h.path == "projects/site.md"));
        assert!(
            notes.search("the and", 5).is_empty(),
            "stop words find nothing"
        );
        assert!(notes.search("kubernetes", 5).is_empty());
    }

    #[test]
    fn a_message_recalls_only_strong_matches_once() {
        let (dir, notes) = vault();
        std::fs::write(
            dir.path().join("topics/js-math-helpers.md"),
            "# JS math helpers\n\nConvention across my JS projects:\n- Every math helper throws \
             TypeError(\"expected numbers\") on bad input. Never return NaN.\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("topics/tauri-gotchas.md"),
            "# Tauri gotchas\nDrag regions.\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("projects/calc.md"),
            "# Calc\nmath helpers live in math.js\n",
        )
        .unwrap();
        let project = Path::new("/code/calc");
        let mut shown = std::collections::HashSet::new();

        let message = "Add an avg(...nums) function to math.js, delegated to the builder.";
        let hits = notes.recall(message, project, &shown);
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].path, "topics/js-math-helpers.md");
        assert!(hits[0].snippet.contains("TypeError"), "{}", hits[0].snippet);
        // This project's own note is already in the brief; it isn't pointed out again.
        assert!(hits.iter().all(|h| h.path != "projects/calc.md"));

        let block = Notes::recall_block(&hits);
        assert!(
            block.contains("<notes-recall>") && block.len() < 600,
            "{}",
            block.len()
        );

        shown.insert(hits[0].path.clone());
        assert!(
            notes.recall(message, project, &shown).is_empty(),
            "once per session"
        );
        assert!(notes
            .recall("rename the button", project, &Default::default())
            .is_empty());
    }

    #[test]
    fn agents_write_projects_and_topics_but_never_me_or_outside() {
        let (dir, notes) = vault();
        let w = notes
            .write_as_agent(
                "topics/auth.md",
                "# Auth\nSessions in cookies.",
                WriteMode::Replace,
            )
            .unwrap();
        assert!(w.created);
        notes
            .write_as_agent(
                "topics/auth.md",
                "- Refresh tokens rotate.",
                WriteMode::Append,
            )
            .unwrap();
        let text = std::fs::read_to_string(dir.path().join("topics/auth.md")).unwrap();
        assert!(text.contains("cookies") && text.contains("rotate"));

        for bad in [
            "me.md",
            "README.md",
            "../escape.md",
            "/etc/x.md",
            "topics/../me.md",
            "topics/x.txt",
            "topics/.hidden.md",
        ] {
            assert!(
                notes.write_as_agent(bad, "x", WriteMode::Replace).is_err(),
                "{bad}"
            );
        }
        // The person can edit their own.
        notes
            .write("me.md", "# About me\nTabs.", WriteMode::Replace)
            .unwrap();
        // And nothing grows without bound.
        let huge = "x".repeat(WRITE_CAP + 1);
        assert!(notes
            .write_as_agent("topics/huge.md", &huge, WriteMode::Replace)
            .is_err());
    }

    #[test]
    fn reading_is_capped_and_listing_is_newest_first() {
        let (dir, notes) = vault();
        std::fs::write(dir.path().join("topics/long.md"), "line\n".repeat(5_000)).unwrap();
        assert!(notes.read("topics/long.md").unwrap().len() < READ_CAP + 100);
        assert!(notes.read("topics/missing.md").is_err());
        assert!(notes.read("../../etc/passwd.md").is_err());
        let listed = notes.list();
        assert!(listed.iter().any(|n| n.path == "topics/long.md"));
        assert!(listed
            .iter()
            .any(|n| n.path == "me.md" && n.title == "About me"));
    }

    #[test]
    fn project_notes_are_named_after_the_folder() {
        assert_eq!(
            Notes::project_note(Path::new("/a/Calendar System")),
            "projects/calendar-system.md"
        );
        assert_eq!(
            Notes::project_note(Path::new("/a/local-harness-")),
            "projects/local-harness.md"
        );
        assert_eq!(Notes::project_note(Path::new("/")), "projects/project.md");
    }
}
