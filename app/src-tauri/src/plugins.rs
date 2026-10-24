//! Plugins in the app: listing, approving and installing them, running their commands,
//! firing their hooks, and serving their panels.
//!
//! A panel is served over the `meridian-plugin` scheme, at a random token per panel per
//! run, and only while its plugin is on. The page runs in a sandboxed frame with no access
//! to the app; it reaches Meridian only through the message bridge in `PluginPanel.tsx`,
//! which offers it the project's state, its own plugin's commands, and the chat box.

use harness_core::plugins::{self, CommandOutput, Plugin, Plugins};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use tauri::http::{Request, Response};
use tauri::{AppHandle, Emitter, State};

use super::{harness_for, AppState};

/// The bridge a panel loads as `__meridian.js`.
const SDK: &str = include_str!("plugin_sdk.js");

/// Panels handed out this run: token → (project root, plugin key).
static PANELS: LazyLock<Mutex<HashMap<String, (PathBuf, String)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn plugins() -> Result<Plugins, String> {
    harness_core::extensions::default_dir()
        .map(Plugins::new)
        .ok_or_else(|| "no home directory to keep plugins in".to_string())
}

/// The enabled plugins for one project; none if the library can't be read.
pub fn enabled(project_root: &Path) -> Vec<Plugin> {
    plugins()
        .map(|p| p.enabled(Some(project_root)))
        .unwrap_or_default()
}

/// Events worth a hook: the lifecycle, not the stream of text and tool calls.
const HOOKED: &[&str] = &[
    "worker_spawned",
    "worker_finished",
    "merge_requested",
    "merge_landed",
    "merge_reverted",
    "verification_finished",
    "plan_finished",
    "pull_request_opened",
    "run_finished",
];

/// Run the project's plugin hooks for an event. Plugins are looked up afresh each time,
/// so one that changed since it was approved doesn't run.
pub fn fire_hooks(project_root: &Path, event: &harness_core::event::HarnessEvent) {
    let Ok(value) = serde_json::to_value(event) else {
        return;
    };
    let kind = value
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or_default();
    if !HOOKED.contains(&kind) {
        return;
    }
    let plugins = enabled(project_root);
    if plugins.iter().any(|p| {
        p.manifest
            .as_ref()
            .is_some_and(|m| m.hooks.iter().any(|h| h.on.iter().any(|e| e == kind)))
    }) {
        plugins::fire_hooks(&plugins, &value, project_root);
    }
}

async fn project_root(state: &AppState, project: Option<String>) -> Result<PathBuf, String> {
    Ok(harness_for(state, project)
        .await?
        .workspaces()
        .project_root()
        .to_path_buf())
}

/// Hand every open project's agents what its plugins now add. Workers get it on their
/// next task; the head agent when it next starts.
async fn refresh_extras(state: &AppState) {
    for session in state.projects.lock().await.values() {
        super::load_extras(&session.harness).await;
    }
}

#[tauri::command]
pub async fn plugins_list(
    state: State<'_, AppState>,
    project: Option<String>,
) -> Result<Vec<Plugin>, String> {
    let root = project_root(&state, project).await.ok();
    Ok(plugins()?.discover(root.as_deref()))
}

#[tauri::command]
pub async fn plugin_set_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    enabled: bool,
    project: Option<String>,
) -> Result<Plugin, String> {
    let root = project_root(&state, project).await?;
    let plugin = plugins()?
        .set_enabled(Some(&root), &key, enabled)
        .map_err(|e| format!("{e:#}"))?;
    refresh_extras(&state).await;
    let _ = app.emit("harness://changed", "plugins");
    Ok(plugin)
}

/// Install from a git URL or a local folder.
#[tauri::command]
pub async fn plugin_install(
    app: AppHandle,
    state: State<'_, AppState>,
    source: String,
) -> Result<Vec<String>, String> {
    let plugins = plugins()?;
    let source = source.trim();
    let names = if source.starts_with("https://") || source.starts_with("git@") {
        plugins.install_from_git(source).await
    } else {
        plugins
            .install_from_dir(Path::new(source))
            .map(|name| vec![name])
    }
    .map_err(|e| format!("{e:#}"))?;
    refresh_extras(&state).await;
    let _ = app.emit("harness://changed", "plugins");
    Ok(names)
}

#[tauri::command]
pub async fn plugin_uninstall(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    plugins()?.uninstall(&name).map_err(|e| format!("{e:#}"))?;
    refresh_extras(&state).await;
    let _ = app.emit("harness://changed", "plugins");
    Ok(())
}

#[tauri::command]
pub async fn plugin_run_command(
    state: State<'_, AppState>,
    key: String,
    command: String,
    project: Option<String>,
) -> Result<CommandOutput, String> {
    let root = project_root(&state, project).await?;
    let plugin = plugins()?
        .find(Some(&root), &key)
        .map_err(|e| format!("{e:#}"))?;
    plugins::run_command(&plugin, &command, &root)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// A token for one panel, to put in its URL: `<token>/<entry>`.
#[tauri::command]
pub async fn plugin_panel(
    state: State<'_, AppState>,
    key: String,
    panel: String,
    project: Option<String>,
) -> Result<String, String> {
    let root = project_root(&state, project).await?;
    let plugin = plugins()?
        .find(Some(&root), &key)
        .map_err(|e| format!("{e:#}"))?;
    if !plugin.is_on() {
        return Err(format!("{} isn't turned on", plugin.name()));
    }
    let spec = plugin
        .panel(&panel)
        .ok_or_else(|| format!("{} has no panel `{panel}`", plugin.name()))?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    PANELS
        .lock()
        .expect("not poisoned")
        .insert(token.clone(), (root, key));
    Ok(format!("{token}/{}", spec.entry))
}

fn mime(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// What a panel's page may load: its own files, data and images, and https for fetches.
/// No frames of its own, and nothing from the app.
const PANEL_CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-inline'; \
     style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; \
     connect-src https:; frame-src 'none'; object-src 'none'; base-uri 'none'";

fn respond(status: u16, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Content-Security-Policy", PANEL_CSP)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .body(body)
        .expect("a well-formed response")
}

/// Serve `meridian-plugin://localhost/<token>/<path>`.
pub fn serve(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    match plugins() {
        Ok(library) => serve_from(&library, request),
        Err(_) => respond(404, "text/plain", b"not found".to_vec()),
    }
}

fn serve_from(library: &Plugins, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let raw = request.uri().path().trim_start_matches('/');
    let path = percent_decode(raw);
    let Some((token, relative)) = path.split_once('/') else {
        return respond(404, "text/plain", b"not found".to_vec());
    };
    let Some((root, key)) = PANELS.lock().expect("not poisoned").get(token).cloned() else {
        return respond(404, "text/plain", b"not found".to_vec());
    };
    // The bridge sits beside every page, wherever its entry is.
    if relative == "__meridian.js" || relative.ends_with("/__meridian.js") {
        return respond(200, mime("x.js"), SDK.as_bytes().to_vec());
    }
    let found = library.find(Some(&root), &key).ok();
    let Some(plugin) = found else {
        return respond(404, "text/plain", b"not found".to_vec());
    };
    match plugins::panel_file(&plugin, relative).and_then(|file| Ok(std::fs::read(file)?)) {
        Ok(bytes) => respond(200, mime(relative), bytes),
        Err(error) => respond(404, "text/plain", format!("{error:#}").into_bytes()),
    }
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_paths_are_decoded_and_typed() {
        assert_eq!(percent_decode("a%20b/c.html"), "a b/c.html");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%2e%2e/x"), "../x");
        assert_eq!(mime("panel/index.html"), "text/html; charset=utf-8");
        assert_eq!(mime("x.exe"), "application/octet-stream");
    }

    fn get(library: &Plugins, path: &str) -> Response<Vec<u8>> {
        let request = Request::builder()
            .uri(format!("meridian-plugin://localhost/{path}"))
            .body(Vec::new())
            .unwrap();
        serve_from(library, &request)
    }

    #[test]
    fn a_panel_is_served_while_its_plugin_is_on_and_nothing_outside_it() {
        let project = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        let dir = project.path().join(plugins::PROJECT_DIR).join("board");
        std::fs::create_dir_all(dir.join("panel")).unwrap();
        std::fs::write(
            dir.join(plugins::MANIFEST),
            "name = \"board\"\n[[panels]]\nid = \"main\"\ntitle = \"Board\"\nentry = \"panel/index.html\"\n",
        )
        .unwrap();
        std::fs::write(dir.join("panel/index.html"), "<h1>board</h1>").unwrap();
        std::fs::write(project.path().join("secret.txt"), "secret").unwrap();
        let library = Plugins::new(app.path());
        library
            .set_enabled(Some(project.path()), "project:board", true)
            .unwrap();
        PANELS.lock().unwrap().insert(
            "tok".into(),
            (project.path().to_path_buf(), "project:board".into()),
        );

        let page = get(&library, "tok/panel/index.html");
        assert_eq!(page.status(), 200);
        assert_eq!(page.body(), b"<h1>board</h1>");
        assert!(page.headers()["Content-Security-Policy"]
            .to_str()
            .unwrap()
            .contains("frame-src 'none'"));
        assert_eq!(get(&library, "tok/panel/__meridian.js").status(), 200);
        for escape in [
            "tok/../../secret.txt",
            "tok/%2e%2e/%2e%2e/%2e%2e/secret.txt",
            "tok/panel/missing.html",
        ] {
            assert_eq!(get(&library, escape).status(), 404, "{escape}");
        }

        // Turned off, or changed since approval: nothing is served.
        std::fs::write(dir.join("panel/index.html"), "<h1>changed</h1>").unwrap();
        assert_eq!(get(&library, "tok/panel/index.html").status(), 404);
    }

    #[test]
    fn unknown_tokens_get_nothing() {
        let request = Request::builder()
            .uri("meridian-plugin://localhost/nope/index.html")
            .body(Vec::new())
            .unwrap();
        assert_eq!(serve(&request).status(), 404);
        let sdk = Request::builder()
            .uri("meridian-plugin://localhost/nope/__meridian.js")
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            serve(&sdk).status(),
            404,
            "not even the bridge without a real token"
        );
    }
}
