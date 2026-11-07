//! Screenshots of pages served on this machine, taken with the Chrome (or Chromium) the
//! person already has, in headless mode. Nothing to install.
//!
//! Only loopback addresses: the point is to look at the app being built (its dev
//! server, a preview), not to browse the web on an agent's say-so.

use anyhow::{bail, Context, Result};
use std::path::PathBuf;
use std::time::Duration;

/// A browser that can take a headless screenshot, if this machine has one.
/// `MERIDIAN_CHROME` wins, then the usual macOS apps, then whatever is on the PATH.
pub fn find_browser() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("MERIDIAN_CHROME").map(PathBuf::from) {
        return path.is_file().then_some(path);
    }
    let apps = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
    if let Some(app) = apps.iter().map(PathBuf::from).find(|p| p.is_file()) {
        return Some(app);
    }
    let path = std::env::var_os("PATH")?;
    [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
    ]
    .iter()
    .flat_map(|name| std::env::split_paths(&path).map(move |dir| dir.join(name)))
    .find(|p| p.is_file())
}

/// Refuse anything but an http(s) page on this machine.
pub fn check_url(url: &str) -> Result<()> {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .context("only http:// or https:// pages on this machine (such as the dev server)")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') {
        bail!("a page address with a user name in it isn't allowed");
    }
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next().unwrap_or_default()
    } else {
        authority.split(':').next().unwrap_or_default()
    }
    .to_ascii_lowercase();
    let loopback = host == "localhost"
        || host.ends_with(".localhost")
        || host == "::1"
        || host
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|ip| ip.is_loopback());
    if !loopback {
        bail!("only pages served on this machine (localhost) can be screenshotted, not `{host}`");
    }
    Ok(())
}

/// Load `url` at `width`×`height` and return a PNG of what it shows.
pub async fn capture(url: &str, width: u32, height: u32) -> Result<Vec<u8>> {
    check_url(url)?;
    let browser = find_browser().context(
        "no Chrome or Chromium on this machine to take the screenshot with; install Google \
         Chrome, or set MERIDIAN_CHROME to a Chromium-based browser",
    )?;
    let (width, height) = (width.clamp(320, 2560), height.clamp(240, 2560));
    let work = Scratch::new()?;
    let out = work.path().join("shot.png");
    let mut command = tokio::process::Command::new(&browser);
    command
        .arg("--headless=new")
        .arg("--disable-gpu")
        .arg("--hide-scrollbars")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--mute-audio")
        .arg(format!(
            "--user-data-dir={}",
            work.path().join("profile").display()
        ))
        .arg(format!("--window-size={width},{height}"))
        // Give scripts time to render before the picture is taken.
        .arg("--virtual-time-budget=5000")
        .arg(format!("--screenshot={}", out.display()));
    if cfg!(target_os = "linux") {
        command.arg("--no-sandbox");
    }
    command
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let run = command.output();
    let output = tokio::time::timeout(Duration::from_secs(45), run)
        .await
        .context("the browser took over 45 seconds; is the page loading?")?
        .with_context(|| format!("running {}", browser.display()))?;
    match std::fs::read(&out) {
        Ok(bytes) if !bytes.is_empty() => Ok(bytes),
        _ => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let hint = stderr
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("");
            bail!("the browser didn't produce a screenshot of {url}. {hint}")
        }
    }
}

/// A folder of its own for one run of the browser (its profile and the picture),
/// removed afterwards.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self> {
        let dir = std::env::temp_dir().join(format!("meridian-shot-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).context("making a scratch folder for the browser")?;
        Ok(Self(dir))
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_pages_on_this_machine() {
        for ok in [
            "http://localhost:5173/",
            "http://127.0.0.1:3000/app?x=1",
            "https://app.localhost/",
            "http://[::1]:8080",
        ] {
            assert!(check_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "https://example.com",
            "http://localhost.evil.com/",
            "http://user@localhost/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "http://10.0.0.5/",
            "http://127.0.0.1.nip.io/",
            "http://127.a.b.c/",
        ] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
    }
}
