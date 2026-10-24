//! Plugins: a folder with a `meridian-plugin.toml` that adds to what Meridian can do.
//!
//! A plugin can bring:
//!
//! * **skills** — `skills/<name>/SKILL.md`, handed to every agent like the library's;
//! * **agent tools** — MCP servers, in Claude Code's own `mcpServers` shape;
//! * **commands** — a shell command or a prompt, one click from the chat box;
//! * **hooks** — a shell command run when something happens (a merge lands, say),
//!   with the event as JSON on its stdin;
//! * **panels** — its own tab in the session: a page in a sandboxed frame that talks to
//!   Meridian only through a small message bridge.
//!
//! Plugins live in two places. Installed ones are in the app's data folder and apply to
//! every project. A project's own are in its `.meridian/plugins/`, versioned with its
//! code — so "make me a plugin" is an ordinary worker task whose change is reviewed
//! before it lands.
//!
//! Nothing a plugin declares runs until the person approves it, and approval is of its
//! exact contents: a digest over every file. A plugin that changes afterwards (a pull, a
//! landed change, an edit) goes back to waiting, because a repository someone cloned
//! could otherwise run whatever it liked the moment it was opened.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The file that makes a folder a plugin.
pub const MANIFEST: &str = "meridian-plugin.toml";
/// Where a project keeps its own plugins.
pub const PROJECT_DIR: &str = ".meridian/plugins";

/// A plugin is a few scripts and pages, not a project; anything bigger is the wrong folder.
const MAX_FILES: usize = 500;
const MAX_BYTES: u64 = 20 * 1024 * 1024;
/// What a command or hook may print before the rest is cut off.
const MAX_OUTPUT: usize = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT: u64 = 120;
const DEFAULT_HOOK_TIMEOUT: u64 = 60;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    /// Lower-case letters, digits and dashes. Namespaces its skills and tools.
    pub name: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub commands: Vec<CommandSpec>,
    #[serde(default)]
    pub hooks: Vec<HookSpec>,
    #[serde(default)]
    pub panels: Vec<PanelSpec>,
    /// Claude Code's `mcpServers` shape: `command` (+ `args`, `env`) or `url`.
    #[serde(default)]
    pub mcp_servers: BTreeMap<String, serde_json::Value>,
}

/// A button: run something, or hand the head agent a prompt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandSpec {
    pub id: String,
    pub title: String,
    /// A shell command, run in the project folder.
    #[serde(default)]
    pub run: Option<String>,
    /// Text put in the chat box, for the person to send.
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookSpec {
    /// Event types, as the app names them: `merge_landed`, `worker_finished`, ….
    pub on: Vec<String>,
    /// A shell command, run in the project folder with the event as JSON on stdin.
    pub run: String,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PanelSpec {
    pub id: String,
    pub title: String,
    /// The page to show, relative to the plugin folder, e.g. `panel/index.html`.
    pub entry: String,
}

/// Where a plugin came from, which decides where it applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    /// Installed in the app: every project.
    Installed,
    /// In the project's `.meridian/plugins/`: this project.
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginState {
    /// Never approved: nothing it declares runs.
    Off,
    On,
    /// Approved once, then changed: off again until approved as it is now.
    Changed,
    /// Its manifest doesn't parse or breaks a rule; it can't be turned on.
    Broken,
}

/// A plugin as found on disk.
#[derive(Debug, Clone, Serialize)]
pub struct Plugin {
    /// `installed:<name>` or `project:<name>`: unique within a project's view.
    pub key: String,
    pub scope: Scope,
    pub dir: PathBuf,
    /// `None` when the manifest couldn't be read; `error` says why.
    pub manifest: Option<Manifest>,
    pub error: Option<String>,
    /// Skill folders under `skills/`.
    pub skills: Vec<String>,
    pub digest: String,
    pub state: PluginState,
    /// Where its commands and hooks may keep things: outside the plugin, whose files are
    /// what's approved, and outside the project, whose files are the person's.
    pub data_dir: PathBuf,
}

impl Plugin {
    pub fn name(&self) -> &str {
        self.manifest
            .as_ref()
            .map(|m| m.name.as_str())
            .unwrap_or_else(|| {
                self.dir
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("plugin")
            })
    }

    pub fn is_on(&self) -> bool {
        self.state == PluginState::On
    }

    pub fn command(&self, id: &str) -> Option<&CommandSpec> {
        self.manifest.as_ref()?.commands.iter().find(|c| c.id == id)
    }

    pub fn panel(&self, id: &str) -> Option<&PanelSpec> {
        self.manifest.as_ref()?.panels.iter().find(|p| p.id == id)
    }
}

/// Approvals, by plugin and the digest that was approved.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Approvals {
    #[serde(default)]
    approved: BTreeMap<String, String>,
}

/// Finds, approves and installs plugins.
pub struct Plugins {
    /// Installed plugins, one folder each.
    installed_dir: PathBuf,
    approvals_path: PathBuf,
    /// Each plugin's own data folder lives under here.
    data_dir: PathBuf,
}

impl Plugins {
    /// `dir` is the app's extensions folder; installed plugins live under it.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        let dir = dir.into();
        Self {
            installed_dir: dir.join("meridian-plugins"),
            approvals_path: dir.join("plugin-approvals.json"),
            data_dir: dir.join("plugin-data"),
        }
    }

    /// Every plugin a project sees: installed ones, then its own.
    pub fn discover(&self, project_root: Option<&Path>) -> Vec<Plugin> {
        let approvals = self.load_approvals();
        let mut found = Vec::new();
        for (scope, base) in [
            (Scope::Installed, Some(self.installed_dir.clone())),
            (
                Scope::Project,
                project_root.map(|root| root.join(PROJECT_DIR)),
            ),
        ] {
            let Some(base) = base else { continue };
            let Ok(entries) = std::fs::read_dir(&base) else {
                continue;
            };
            let mut dirs: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir() && p.join(MANIFEST).is_file())
                .collect();
            dirs.sort();
            for dir in dirs {
                let mut plugin = load(scope, &dir, project_root, &approvals);
                plugin.data_dir = self.data_dir.join(data_folder(&plugin, project_root));
                found.push(plugin);
            }
        }
        found
    }

    /// The plugins that are on, for one project.
    pub fn enabled(&self, project_root: Option<&Path>) -> Vec<Plugin> {
        self.discover(project_root)
            .into_iter()
            .filter(Plugin::is_on)
            .collect()
    }

    pub fn find(&self, project_root: Option<&Path>, key: &str) -> Result<Plugin> {
        self.discover(project_root)
            .into_iter()
            .find(|p| p.key == key)
            .with_context(|| format!("there's no plugin `{key}`"))
    }

    /// Turn a plugin on — as it is right now — or off.
    pub fn set_enabled(&self, project_root: Option<&Path>, key: &str, on: bool) -> Result<Plugin> {
        let plugin = self.find(project_root, key)?;
        if on && plugin.state == PluginState::Broken {
            bail!(
                "{} can't be turned on: {}",
                plugin.name(),
                plugin.error.as_deref().unwrap_or("its manifest is broken")
            );
        }
        let mut approvals = self.load_approvals();
        let approval = approval_key(&plugin, project_root);
        if on {
            approvals.approved.insert(approval, plugin.digest.clone());
        } else {
            approvals.approved.remove(&approval);
        }
        self.save_approvals(&approvals)?;
        self.find(project_root, key)
    }

    /// Copy a plugin folder in as an installed plugin. One that's already installed
    /// under the same name is replaced, and has to be approved again.
    pub fn install_from_dir(&self, source: &Path) -> Result<String> {
        let manifest = read_manifest(source)?;
        let files = list_files(source)?;
        let target = self.installed_dir.join(&manifest.name);
        let staging = self
            .installed_dir
            .join(format!(".installing-{}", uuid::Uuid::new_v4().simple()));
        for relative in &files {
            let to = staging.join(relative);
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(source.join(relative), &to)
                .with_context(|| format!("copying {}", relative.display()))?;
        }
        if target.exists() {
            std::fs::remove_dir_all(&target)?;
        }
        std::fs::rename(&staging, &target)?;
        Ok(manifest.name)
    }

    /// Clone a git repository and install the plugin at its root, or every plugin one
    /// level down (a repository of several).
    pub async fn install_from_git(&self, url: &str) -> Result<Vec<String>> {
        let ok_url = url.starts_with("https://") || url.starts_with("git@");
        if !ok_url || url.contains(char::is_whitespace) {
            bail!("give an https:// or git@ repository URL");
        }
        let temp =
            std::env::temp_dir().join(format!("meridian-plugin-{}", uuid::Uuid::new_v4().simple()));
        let output = tokio::process::Command::new("git")
            .args(["clone", "--depth", "1", "--", url])
            .arg(&temp)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .await
            .context("running git")?;
        if !output.status.success() {
            let _ = std::fs::remove_dir_all(&temp);
            bail!(
                "git clone failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        let _ = std::fs::remove_dir_all(temp.join(".git"));
        let result = self.install_all(&temp);
        let _ = std::fs::remove_dir_all(&temp);
        result
    }

    fn install_all(&self, root: &Path) -> Result<Vec<String>> {
        if root.join(MANIFEST).is_file() {
            return Ok(vec![self.install_from_dir(root)?]);
        }
        let mut installed = Vec::new();
        let mut dirs: Vec<PathBuf> = std::fs::read_dir(root)?
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.join(MANIFEST).is_file())
            .collect();
        dirs.sort();
        for dir in dirs {
            installed.push(self.install_from_dir(&dir)?);
        }
        if installed.is_empty() {
            bail!("no {MANIFEST} at the repository's root or one level down");
        }
        Ok(installed)
    }

    /// Remove an installed plugin. A project's own are removed like any other file.
    pub fn uninstall(&self, name: &str) -> Result<()> {
        check_name(name)?;
        let dir = self.installed_dir.join(name);
        if !dir.join(MANIFEST).is_file() {
            bail!("there's no installed plugin `{name}`");
        }
        std::fs::remove_dir_all(&dir)?;
        let mut approvals = self.load_approvals();
        approvals.approved.remove(&format!("installed:{name}"));
        self.save_approvals(&approvals)
    }

    fn load_approvals(&self) -> Approvals {
        std::fs::read_to_string(&self.approvals_path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn save_approvals(&self, approvals: &Approvals) -> Result<()> {
        if let Some(parent) = self.approvals_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = self
            .approvals_path
            .with_extension(format!("json.{}.tmp", std::process::id()));
        std::fs::write(&tmp, serde_json::to_string_pretty(approvals)?)?;
        std::fs::rename(&tmp, &self.approvals_path)?;
        Ok(())
    }
}

/// Approvals are per project for a project's own plugins: approving a plugin called
/// `deploy` in one repository says nothing about another repository's `deploy`.
fn approval_key(plugin: &Plugin, project_root: Option<&Path>) -> String {
    match plugin.scope {
        Scope::Installed => plugin.key.clone(),
        Scope::Project => {
            let root = project_root
                .and_then(|r| r.canonicalize().ok())
                .map(|r| r.display().to_string())
                .unwrap_or_default();
            format!("project:{root}:{}", plugin.name())
        }
    }
}

/// A plugin's data folder name: per project for a project's own, so two repositories'
/// `deploy` plugins don't share state.
fn data_folder(plugin: &Plugin, project_root: Option<&Path>) -> String {
    match plugin.scope {
        Scope::Installed => format!("installed-{}", plugin.name()),
        Scope::Project => {
            let mut hasher = Sha256::new();
            hasher.update(approval_key(plugin, project_root).as_bytes());
            let short: String = hasher.finalize()[..6]
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            format!("project-{}-{short}", plugin.name())
        }
    }
}

fn load(scope: Scope, dir: &Path, project_root: Option<&Path>, approvals: &Approvals) -> Plugin {
    let prefix = match scope {
        Scope::Installed => "installed",
        Scope::Project => "project",
    };
    let folder = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let digest = digest(dir).unwrap_or_default();
    let (manifest, mut error) = match read_manifest(dir) {
        Ok(manifest) if manifest.name != folder => (
            None,
            Some(format!(
                "its manifest says `{}` but its folder is `{folder}`; they must match",
                manifest.name
            )),
        ),
        Ok(manifest) => (Some(manifest), None),
        Err(e) => (None, Some(format!("{e:#}"))),
    };
    if digest.is_empty() && error.is_none() {
        error = Some(format!(
            "too big to be a plugin (over {MAX_FILES} files or {} MB)",
            MAX_BYTES / 1024 / 1024
        ));
    }
    let skills = skill_names(dir);
    let mut plugin = Plugin {
        key: format!("{prefix}:{folder}"),
        scope,
        dir: dir.to_path_buf(),
        manifest,
        error,
        skills,
        digest,
        state: PluginState::Off,
        data_dir: PathBuf::new(),
    };
    plugin.state = if plugin.error.is_some() {
        PluginState::Broken
    } else {
        match approvals.approved.get(&approval_key(&plugin, project_root)) {
            Some(approved) if *approved == plugin.digest => PluginState::On,
            Some(_) => PluginState::Changed,
            None => PluginState::Off,
        }
    };
    plugin
}

fn read_manifest(dir: &Path) -> Result<Manifest> {
    let text = std::fs::read_to_string(dir.join(MANIFEST))
        .with_context(|| format!("reading {MANIFEST}"))?;
    let manifest: Manifest =
        toml::from_str(&text).with_context(|| format!("parsing {MANIFEST}"))?;
    validate(&manifest, dir)?;
    Ok(manifest)
}

fn check_name(name: &str) -> Result<()> {
    let ok = !name.is_empty()
        && name.len() <= 40
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok {
        bail!("`{name}` isn't a plugin name: lower-case letters, digits and dashes");
    }
    Ok(())
}

fn check_id(kind: &str, id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 40
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !ok {
        bail!("{kind} id `{id}`: letters, digits, dashes and underscores");
    }
    Ok(())
}

/// A path inside the plugin, never out of it.
fn inside(dir: &Path, relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        bail!("`{relative}` must be a plain path inside the plugin");
    }
    Ok(dir.join(path))
}

fn validate(manifest: &Manifest, dir: &Path) -> Result<()> {
    check_name(&manifest.name)?;
    let mut ids = std::collections::BTreeSet::new();
    for command in &manifest.commands {
        check_id("command", &command.id)?;
        if !ids.insert(format!("c:{}", command.id)) {
            bail!("two commands are called `{}`", command.id);
        }
        match (&command.run, &command.prompt) {
            (Some(run), None) if !run.trim().is_empty() => {}
            (None, Some(prompt)) if !prompt.trim().is_empty() => {}
            _ => bail!(
                "command `{}` needs either `run` or `prompt`, not both",
                command.id
            ),
        }
    }
    for hook in &manifest.hooks {
        if hook.on.is_empty() || hook.run.trim().is_empty() {
            bail!("a hook needs events in `on` and a command in `run`");
        }
        for event in &hook.on {
            check_id("hook event", event)?;
        }
    }
    for panel in &manifest.panels {
        check_id("panel", &panel.id)?;
        if !ids.insert(format!("p:{}", panel.id)) {
            bail!("two panels are called `{}`", panel.id);
        }
        let entry = inside(dir, &panel.entry)?;
        if !entry.is_file() {
            bail!("panel `{}`: there's no `{}`", panel.id, panel.entry);
        }
    }
    for (name, config) in &manifest.mcp_servers {
        check_id("MCP server", name)?;
        crate::extensions::check_server_config(config)
            .with_context(|| format!("MCP server `{name}`"))?;
    }
    Ok(())
}

fn skill_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir.join("skills")) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().join("SKILL.md").is_file())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| check_id("skill", n).is_ok())
        .collect();
    names.sort();
    names
}

/// Every file in the plugin, relative to it, sorted. Symlinks aren't followed: a plugin
/// that links to `~/.ssh` would otherwise be installed with it.
pub fn list_files(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut total = 0u64;
    let mut stack = vec![PathBuf::new()];
    while let Some(relative) = stack.pop() {
        for entry in std::fs::read_dir(dir.join(&relative))? {
            let entry = entry?;
            let name = entry.file_name();
            if name == ".git" || name == "node_modules" || name == ".DS_Store" {
                continue;
            }
            let kind = entry.file_type()?;
            let path = relative.join(&name);
            if kind.is_dir() {
                stack.push(path);
            } else if kind.is_file() {
                total += entry.metadata()?.len();
                out.push(path);
            }
            if out.len() > MAX_FILES || total > MAX_BYTES {
                bail!(
                    "too big to be a plugin (over {MAX_FILES} files or {} MB)",
                    MAX_BYTES / 1024 / 1024
                );
            }
        }
    }
    out.sort();
    Ok(out)
}

/// SHA-256 over every file's path and contents: what an approval is of.
fn digest(dir: &Path) -> Result<String> {
    let mut hasher = Sha256::new();
    for relative in list_files(dir)? {
        let path = relative.to_string_lossy().replace('\\', "/");
        let bytes = std::fs::read(dir.join(&relative))?;
        hasher.update((path.len() as u64).to_le_bytes());
        hasher.update(path.as_bytes());
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(&bytes);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// What a command printed.
#[derive(Debug, Clone, Serialize)]
pub struct CommandOutput {
    pub exit_code: Option<i32>,
    pub output: String,
    pub truncated: bool,
    pub timed_out: bool,
}

async fn run_shell(
    plugin: &Plugin,
    command: &str,
    project_root: &Path,
    stdin: Option<&[u8]>,
    timeout: u64,
) -> Result<CommandOutput> {
    use tokio::io::AsyncWriteExt;
    std::fs::create_dir_all(&plugin.data_dir).context("making the plugin's data folder")?;
    let mut child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(project_root)
        .env("MERIDIAN_PLUGIN_DIR", &plugin.dir)
        .env("MERIDIAN_PLUGIN_DATA", &plugin.data_dir)
        .env("MERIDIAN_PROJECT", project_root)
        .stdin(if stdin.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("starting the command")?;
    if let (Some(bytes), Some(mut input)) = (stdin, child.stdin.take()) {
        // A hook that doesn't read its stdin is fine; don't fail on a closed pipe.
        let _ = input.write_all(bytes).await;
    }
    match tokio::time::timeout(Duration::from_secs(timeout), child.wait_with_output()).await {
        Ok(output) => {
            let output = output?;
            let mut text = String::from_utf8_lossy(&output.stdout).to_string();
            let err = String::from_utf8_lossy(&output.stderr);
            if !err.trim().is_empty() {
                if !text.is_empty() && !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str(&err);
            }
            let truncated = text.len() > MAX_OUTPUT;
            if truncated {
                let mut cut = MAX_OUTPUT;
                while !text.is_char_boundary(cut) {
                    cut -= 1;
                }
                text.truncate(cut);
            }
            Ok(CommandOutput {
                exit_code: output.status.code(),
                output: text,
                truncated,
                timed_out: false,
            })
        }
        Err(_) => Ok(CommandOutput {
            exit_code: None,
            output: format!("stopped after {timeout}s"),
            truncated: false,
            timed_out: true,
        }),
    }
}

/// Run one of an enabled plugin's `run` commands in the project folder.
pub async fn run_command(plugin: &Plugin, id: &str, project_root: &Path) -> Result<CommandOutput> {
    if !plugin.is_on() {
        bail!("{} isn't turned on", plugin.name());
    }
    let command = plugin
        .command(id)
        .with_context(|| format!("{} has no command `{id}`", plugin.name()))?;
    let run = command
        .run
        .as_deref()
        .with_context(|| format!("`{id}` is a prompt, not something to run"))?;
    run_shell(
        plugin,
        run,
        project_root,
        None,
        command.timeout_secs.unwrap_or(DEFAULT_COMMAND_TIMEOUT),
    )
    .await
}

/// Run every enabled plugin's hooks for an event, in the background. `event` is the
/// event as the app sends it, JSON with a `type`.
pub fn fire_hooks(plugins: &[Plugin], event: &serde_json::Value, project_root: &Path) {
    let Some(kind) = event.get("type").and_then(|t| t.as_str()) else {
        return;
    };
    for plugin in plugins.iter().filter(|p| p.is_on()) {
        let Some(manifest) = &plugin.manifest else {
            continue;
        };
        for hook in manifest
            .hooks
            .iter()
            .filter(|h| h.on.iter().any(|e| e == kind))
        {
            let plugin = plugin.clone();
            let hook = hook.clone();
            let root = project_root.to_path_buf();
            let payload = event.to_string().into_bytes();
            tokio::spawn(async move {
                let timeout = hook.timeout_secs.unwrap_or(DEFAULT_HOOK_TIMEOUT);
                match run_shell(&plugin, &hook.run, &root, Some(&payload), timeout).await {
                    Ok(out) if out.exit_code == Some(0) => {}
                    Ok(out) => tracing::warn!(
                        "plugin {} hook `{}` exited {:?}: {}",
                        plugin.name(),
                        hook.run,
                        out.exit_code,
                        out.output.trim()
                    ),
                    Err(error) => tracing::warn!("plugin {} hook failed: {error:#}", plugin.name()),
                }
            });
        }
    }
}

/// A file a panel may load: inside its plugin, from an enabled plugin with that panel.
pub fn panel_file(plugin: &Plugin, relative: &str) -> Result<PathBuf> {
    if !plugin.is_on() {
        bail!("{} isn't turned on", plugin.name());
    }
    let path = inside(&plugin.dir, relative)?;
    let real = path.canonicalize().context("no such file")?;
    let root = plugin.dir.canonicalize()?;
    if !real.starts_with(&root) {
        bail!("`{relative}` leads outside the plugin");
    }
    Ok(real)
}

/// The skills an enabled plugin adds, as (name the agents see, folder).
pub fn skill_dirs(plugins: &[Plugin]) -> Vec<(String, PathBuf)> {
    plugins
        .iter()
        .filter(|p| p.is_on())
        .flat_map(|p| {
            p.skills
                .iter()
                .map(move |s| (format!("{}-{s}", p.name()), p.dir.join("skills").join(s)))
        })
        .collect()
}

/// The MCP servers enabled plugins add, named `<plugin>-<server>`.
pub fn mcp_servers(plugins: &[Plugin]) -> BTreeMap<String, serde_json::Value> {
    let mut servers = BTreeMap::new();
    for plugin in plugins.iter().filter(|p| p.is_on()) {
        let Some(manifest) = &plugin.manifest else {
            continue;
        };
        for (name, config) in &manifest.mcp_servers {
            servers.insert(format!("{}-{name}", plugin.name()), config.clone());
        }
    }
    servers
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, relative: &str, text: &str) {
        let path = dir.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    const LINT: &str = r#"
name = "lint-guard"
title = "Lint guard"
description = "Lint before landing."

[[commands]]
id = "lint"
title = "Run lint"
run = "echo linted; echo warn >&2"

[[commands]]
id = "fix"
title = "Ask for fixes"
prompt = "Have a builder fix the lint errors."

[[hooks]]
on = ["merge_landed"]
run = "cat > \"$MERIDIAN_PLUGIN_DATA/last-event.json\""

[[panels]]
id = "report"
title = "Lint"
entry = "panel/index.html"

[mcp_servers.eslint]
command = "npx"
args = ["eslint-mcp"]
"#;

    fn project_with_plugin() -> (tempfile::TempDir, tempfile::TempDir, Plugins) {
        let project = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        let dir = project.path().join(PROJECT_DIR).join("lint-guard");
        write(&dir, MANIFEST, LINT);
        write(&dir, "panel/index.html", "<h1>lint</h1>");
        write(
            &dir,
            "skills/fix-lint/SKILL.md",
            "---\nname: fix-lint\n---\nFix it.",
        );
        let plugins = Plugins::new(app.path());
        (project, app, plugins)
    }

    #[test]
    fn a_project_plugin_is_found_off_and_runs_nothing_until_approved() {
        let (project, _app, plugins) = project_with_plugin();
        let root = Some(project.path());
        let found = plugins.discover(root);
        assert_eq!(found.len(), 1);
        let plugin = &found[0];
        assert_eq!(plugin.key, "project:lint-guard");
        assert_eq!(plugin.state, PluginState::Off);
        assert_eq!(plugin.skills, ["fix-lint"]);
        assert!(plugins.enabled(root).is_empty());
        assert!(skill_dirs(&found).is_empty() && mcp_servers(&found).is_empty());

        let on = plugins
            .set_enabled(root, "project:lint-guard", true)
            .unwrap();
        assert_eq!(on.state, PluginState::On);
        let enabled = plugins.enabled(root);
        assert_eq!(skill_dirs(&enabled)[0].0, "lint-guard-fix-lint");
        assert!(mcp_servers(&enabled).contains_key("lint-guard-eslint"));
    }

    #[test]
    fn an_enabled_plugins_skills_and_tools_reach_the_agents() {
        let (project, app, plugins) = project_with_plugin();
        let root = Some(project.path());
        let extensions = crate::extensions::Extensions::new(app.path());
        let before = extensions
            .worker_extras_with(&plugins.enabled(root))
            .unwrap();
        assert!(!before.mcp_servers.contains_key("lint-guard-eslint"));

        plugins
            .set_enabled(root, "project:lint-guard", true)
            .unwrap();
        let extras = extensions
            .worker_extras_with(&plugins.enabled(root))
            .unwrap();
        let dir = extras.plugin_dir.unwrap();
        assert!(dir.join("skills/lint-guard-fix-lint/SKILL.md").is_file());
        assert_eq!(extras.mcp_servers["lint-guard-eslint"]["command"], "npx");
    }

    #[test]
    fn a_change_after_approval_turns_it_off_until_approved_again() {
        let (project, _app, plugins) = project_with_plugin();
        let root = Some(project.path());
        plugins
            .set_enabled(root, "project:lint-guard", true)
            .unwrap();
        write(
            &project.path().join(PROJECT_DIR).join("lint-guard"),
            "panel/index.html",
            "<script>evil()</script>",
        );
        let plugin = plugins.find(root, "project:lint-guard").unwrap();
        assert_eq!(plugin.state, PluginState::Changed);
        assert!(plugins.enabled(root).is_empty());
    }

    #[test]
    fn approving_one_projects_plugin_says_nothing_about_another_projects() {
        let (project, app, plugins) = project_with_plugin();
        plugins
            .set_enabled(Some(project.path()), "project:lint-guard", true)
            .unwrap();

        let other = tempfile::tempdir().unwrap();
        let dir = other.path().join(PROJECT_DIR).join("lint-guard");
        write(&dir, MANIFEST, LINT);
        write(&dir, "panel/index.html", "<h1>lint</h1>");
        write(
            &dir,
            "skills/fix-lint/SKILL.md",
            "---\nname: fix-lint\n---\nFix it.",
        );
        let again = Plugins::new(app.path());
        assert_eq!(
            again
                .find(Some(other.path()), "project:lint-guard")
                .unwrap()
                .state,
            PluginState::Off
        );
    }

    #[test]
    fn broken_manifests_are_listed_with_the_reason_and_cannot_be_turned_on() {
        let project = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        let base = project.path().join(PROJECT_DIR);
        for (folder, manifest, why) in [
            ("bad-name", "name = \"Bad Name\"", "isn't a plugin name"),
            ("mismatch", "name = \"other\"", "must match"),
            ("both", "name = \"both\"\n[[commands]]\nid = \"x\"\ntitle = \"x\"\nrun = \"a\"\nprompt = \"b\"", "not both"),
            ("escape", "name = \"escape\"\n[[panels]]\nid = \"p\"\ntitle = \"p\"\nentry = \"../../secret.html\"", "plain path"),
            ("server", "name = \"server\"\n[mcp_servers.s]\nfoo = 1", "MCP server"),
            ("unknown", "name = \"unknown\"\nsurprise = true", "parsing"),
        ] {
            write(&base.join(folder), MANIFEST, manifest);
            let plugins = Plugins::new(app.path());
            let plugin = plugins.find(Some(project.path()), &format!("project:{folder}")).unwrap();
            assert_eq!(plugin.state, PluginState::Broken, "{folder}");
            let error = plugin.error.unwrap_or_default();
            assert!(error.contains(why), "{folder}: {error}");
            assert!(plugins.set_enabled(Some(project.path()), &format!("project:{folder}"), true).is_err());
        }
    }

    #[tokio::test]
    async fn commands_run_in_the_project_only_once_on() {
        let (project, _app, plugins) = project_with_plugin();
        let root = Some(project.path());
        let off = plugins.find(root, "project:lint-guard").unwrap();
        assert!(run_command(&off, "lint", project.path()).await.is_err());

        let on = plugins
            .set_enabled(root, "project:lint-guard", true)
            .unwrap();
        let out = run_command(&on, "lint", project.path()).await.unwrap();
        assert_eq!(out.exit_code, Some(0));
        assert!(out.output.contains("linted") && out.output.contains("warn"));
        // A prompt isn't something to run.
        assert!(run_command(&on, "fix", project.path()).await.is_err());
    }

    #[tokio::test]
    async fn hooks_get_the_event_on_stdin() {
        let (project, _app, plugins) = project_with_plugin();
        let root = Some(project.path());
        let on = plugins
            .set_enabled(root, "project:lint-guard", true)
            .unwrap();
        let event = serde_json::json!({ "type": "merge_landed", "worker_id": "w-1" });
        fire_hooks(std::slice::from_ref(&on), &event, project.path());
        fire_hooks(
            std::slice::from_ref(&on),
            &serde_json::json!({ "type": "worker_finished" }),
            project.path(),
        );
        let written = on.data_dir.join("last-event.json");
        for _ in 0..50 {
            if written.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let got: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(written).unwrap()).unwrap();
        assert_eq!(got["worker_id"], "w-1");
        // Writing its data didn't touch what was approved.
        assert_eq!(
            plugins.find(root, "project:lint-guard").unwrap().state,
            PluginState::On
        );
        assert!(!on.data_dir.starts_with(project.path()));
    }

    #[test]
    fn panel_files_stay_inside_the_plugin() {
        let (project, _app, plugins) = project_with_plugin();
        let root = Some(project.path());
        write(project.path(), "secret.txt", "s");
        let off = plugins.find(root, "project:lint-guard").unwrap();
        assert!(
            panel_file(&off, "panel/index.html").is_err(),
            "not while off"
        );
        let on = plugins
            .set_enabled(root, "project:lint-guard", true)
            .unwrap();
        assert!(panel_file(&on, "panel/index.html").is_ok());
        for bad in [
            "../../secret.txt",
            "/etc/passwd",
            "panel/../../../secret.txt",
            "missing.html",
        ] {
            assert!(panel_file(&on, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn installing_copies_the_folder_and_a_reinstall_needs_approving_again() {
        let (project, app, plugins) = project_with_plugin();
        let source = project.path().join(PROJECT_DIR).join("lint-guard");
        assert_eq!(plugins.install_from_dir(&source).unwrap(), "lint-guard");
        let installed = plugins.find(None, "installed:lint-guard").unwrap();
        assert_eq!(installed.scope, Scope::Installed);
        assert!(app
            .path()
            .join("meridian-plugins/lint-guard")
            .join(MANIFEST)
            .is_file());

        plugins
            .set_enabled(None, "installed:lint-guard", true)
            .unwrap();
        write(&source, "README.md", "now different");
        plugins.install_from_dir(&source).unwrap();
        assert_eq!(
            plugins.find(None, "installed:lint-guard").unwrap().state,
            PluginState::Changed
        );

        plugins.uninstall("lint-guard").unwrap();
        assert!(plugins.find(None, "installed:lint-guard").is_err());
        assert!(plugins.uninstall("../escape").is_err());
    }

    /// The example the repository ships, end to end: it validates, its commands run, and
    /// its hook logs a landed merge where its command reads it back.
    #[tokio::test]
    async fn the_example_plugin_works() {
        let example =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins/session-board");
        let project = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        let status = std::process::Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(project.path())
            .status()
            .unwrap();
        assert!(status.success());
        let plugins = Plugins::new(app.path());
        assert_eq!(plugins.install_from_dir(&example).unwrap(), "session-board");
        let plugin = plugins
            .set_enabled(None, "installed:session-board", true)
            .unwrap();
        assert_eq!(plugin.state, PluginState::On, "{:?}", plugin.error);
        assert_eq!(plugin.skills, ["standup"]);

        let out = run_command(&plugin, "git-status", project.path())
            .await
            .unwrap();
        assert!(out.output.contains("main"), "{}", out.output);
        let empty = run_command(&plugin, "landed", project.path())
            .await
            .unwrap();
        assert!(
            empty.output.contains("Nothing has landed"),
            "{}",
            empty.output
        );

        let event = serde_json::json!({ "type": "merge_landed", "worker_id": "w-7" });
        fire_hooks(std::slice::from_ref(&plugin), &event, project.path());
        let log = plugin.data_dir.join("landed.log");
        for _ in 0..60 {
            if log.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let landed = run_command(&plugin, "landed", project.path())
            .await
            .unwrap();
        assert!(landed.output.contains("w-7"), "{}", landed.output);
        assert_eq!(
            plugins.find(None, "installed:session-board").unwrap().state,
            PluginState::On
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_followed_into_a_plugin() {
        let (project, _app, plugins) = project_with_plugin();
        let dir = project.path().join(PROJECT_DIR).join("lint-guard");
        std::os::unix::fs::symlink("/etc", dir.join("etc-link")).unwrap();
        let files = list_files(&dir).unwrap();
        assert!(files.iter().all(|f| !f.starts_with("etc-link")));
        plugins.install_from_dir(&dir).unwrap();
    }
}
