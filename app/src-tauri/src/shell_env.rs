//! An app opened from Finder or the Dock doesn't get the PATH a terminal has: macOS
//! starts it with `/usr/bin:/bin:/usr/sbin:/sbin`, so `claude`, `codex`, `gh` and
//! `node` (Homebrew, npm, nvm) can't be found. Before anything runs, ask the person's
//! own login shell for its PATH and use that, plus the usual install folders.

use std::path::{Path, PathBuf};
use std::time::Duration;

const MARKER: &str = "__MERIDIAN_PATH__=";

/// Adopt the login shell's PATH, unless this was started from a terminal (which already
/// has it). Never fails: at worst, PATH stays as it was plus the usual folders.
pub fn adopt_login_path() {
    if !cfg!(target_os = "macos") || std::env::var_os("TERM").is_some() {
        return;
    }
    let current = std::env::var("PATH").unwrap_or_default();
    let login = login_shell_path().unwrap_or_default();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let merged = merge(&login, &current, &fallbacks(home.as_deref()));
    if merged != current {
        tracing::info!("using the login shell's PATH");
        std::env::set_var("PATH", merged);
    }
}

/// Where the tools usually live, for when the shell itself can't say.
fn fallbacks(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = home {
        for sub in [
            ".local/bin",
            ".npm-global/bin",
            ".bun/bin",
            ".cargo/bin",
            ".volta/bin",
        ] {
            dirs.push(home.join(sub));
        }
    }
    dirs.into_iter().filter(|d| d.is_dir()).collect()
}

/// `$SHELL -ilc`, so `.zprofile` and `.zshrc` (nvm, Homebrew's shellenv) both run.
/// Bounded: a shell that hangs on startup must not stop the app opening.
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let child = std::process::Command::new(shell)
        .args(["-ilc", &format!("printf '\\n{MARKER}%s\\n' \"$PATH\"")])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let output = rx.recv_timeout(Duration::from_secs(4)).ok()?.ok()?;
    parse(&String::from_utf8_lossy(&output.stdout))
}

/// The PATH after the marker; whatever the shell's startup files printed is ignored.
fn parse(output: &str) -> Option<String> {
    output
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix(MARKER))
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
}

/// The login shell's folders first, then the ones already set, then the usual folders,
/// each once.
fn merge(login: &str, current: &str, fallbacks: &[PathBuf]) -> String {
    let mut seen = std::collections::HashSet::new();
    let fallbacks: Vec<String> = fallbacks.iter().map(|d| d.display().to_string()).collect();
    login
        .split(':')
        .chain(current.split(':'))
        .chain(fallbacks.iter().map(String::as_str))
        .filter(|d| !d.is_empty() && seen.insert(d.to_string()))
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_path_is_read_past_whatever_startup_files_print() {
        let out = format!("Welcome!\nnvm: using node 22\n\n{MARKER}/opt/homebrew/bin:/usr/bin\n");
        assert_eq!(parse(&out).as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
        assert_eq!(parse("no marker here"), None);
    }

    #[test]
    fn login_folders_come_first_and_nothing_repeats() {
        let merged = merge(
            "/Users/z/.nvm/bin:/opt/homebrew/bin:/usr/bin",
            "/usr/bin:/bin",
            &[
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/Users/z/.local/bin"),
            ],
        );
        assert_eq!(
            merged,
            "/Users/z/.nvm/bin:/opt/homebrew/bin:/usr/bin:/bin:/Users/z/.local/bin"
        );
    }
}
