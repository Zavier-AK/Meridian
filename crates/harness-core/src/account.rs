//! Which `claude` the app runs, and whether it is signed in.
//!
//! A sign-in can look fine in a terminal and still fail here: the app may find a different
//! `claude` on its PATH, or a long-lived head agent may hold a token that another Claude
//! process has since refreshed (refresh tokens are single-use). This reports what the app
//! itself sees, using the same program and environment its agents run with.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;

#[derive(Debug, Clone, Default, Serialize)]
pub struct ClaudeAccount {
    /// The `claude` the app runs, or `None` if it isn't on the PATH.
    pub path: Option<String>,
    pub version: Option<String>,
    pub logged_in: bool,
    /// e.g. `oauth_token` for a Claude subscription, `api_key` for Console billing.
    pub method: Option<String>,
    /// Why the status couldn't be read, if it couldn't.
    pub problem: Option<String>,
}

/// The first `claude` on the PATH the app's agents are spawned with.
pub fn claude_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("claude"))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

async fn run(program: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    // The same scrubbing the agents get, so the answer is about the same sign-in.
    crate::agents::scrub_api_keys(&mut command);
    let output = tokio::time::timeout(Duration::from_secs(20), command.output())
        .await
        .map_err(|_| "it took longer than 20 seconds to answer".to_string())?
        .map_err(|e| format!("could not run it: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

/// What the app's `claude` says about its sign-in. Never fails: a problem is reported in
/// the result, so the panel can say what's wrong.
pub async fn claude_account() -> ClaudeAccount {
    let Some(path) = claude_path() else {
        return ClaudeAccount {
            problem: Some(
                "the Claude CLI isn't on the PATH Meridian sees. Install it, or start Meridian \
                 from a terminal where `claude` works."
                    .into(),
            ),
            ..Default::default()
        };
    };
    let mut account = ClaudeAccount {
        path: Some(path.display().to_string()),
        version: run(&path, &["--version"]).await.ok(),
        ..Default::default()
    };
    match run(&path, &["auth", "status", "--json"]).await {
        Ok(out) => match serde_json::from_str::<serde_json::Value>(&out) {
            Ok(status) => {
                account.logged_in = status["loggedIn"].as_bool().unwrap_or(false);
                account.method = status["authMethod"].as_str().map(str::to_string);
            }
            Err(_) => account.problem = Some(format!("unexpected answer: {out}")),
        },
        Err(err) => account.problem = Some(err),
    }
    account
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_missing_cli_is_reported_not_raised() {
        // An executable named `claude` that answers like the real one.
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("claude");
        std::fs::write(
            &fake,
            "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '9.9.9 (Claude Code)'; else echo '{\"loggedIn\":false,\"authMethod\":\"none\"}'; fi\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert!(is_executable(&fake));
        assert_eq!(
            run(&fake, &["--version"]).await.unwrap(),
            "9.9.9 (Claude Code)"
        );
        let status: serde_json::Value =
            serde_json::from_str(&run(&fake, &["auth", "status", "--json"]).await.unwrap())
                .unwrap();
        assert_eq!(status["loggedIn"], false);
        assert!(!is_executable(&dir.path().join("nothing")));
    }
}
