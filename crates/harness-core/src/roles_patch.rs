//! Surgical updates to `roles.toml`.
//!
//! The fleet file is documentation as well as configuration, so serializing a parsed
//! registry back to TOML would be destructive: comments, examples, and formatting would
//! disappear. This patcher changes only `model` and `base_url` in existing role tables,
//! then validates the complete result before atomically replacing the file.

use anyhow::{bail, Context, Result};
use std::path::Path;

use crate::detection::RoleModelPatch;
use crate::roles::RoleRegistry;

pub fn apply_role_patches(source: &str, patches: &[RoleModelPatch]) -> Result<String> {
    let mut lines: Vec<String> = source.lines().map(str::to_string).collect();
    let had_trailing_newline = source.ends_with('\n');

    for patch in patches {
        let header = format!("[roles.{}]", patch.role_name);
        let start = lines
            .iter()
            .position(|line| line.trim() == header)
            .with_context(|| format!("roles.toml has no table `{header}`"))?;
        let end = lines[start + 1..]
            .iter()
            .position(|line| line.trim_start().starts_with('['))
            .map(|offset| start + 1 + offset)
            .unwrap_or(lines.len());

        // `provider` first: it is the field the others are inserted relative to, so
        // rewriting it before them keeps a provider swap from landing out of order.
        if let Some(provider) = &patch.provider {
            set_string_field(&mut lines, start, end, "provider", provider)?;
        }

        let end = table_end(&lines, start);
        set_string_field(&mut lines, start, end, "model", &patch.model)?;

        let end = table_end(&lines, start);
        match &patch.base_url {
            Some(base_url) => set_string_field(&mut lines, start, end, "base_url", base_url)?,
            None => remove_field(&mut lines, start, end, "base_url"),
        }

        // Written as an inline table, matching how roles.toml already spells it. An
        // empty map removes the key rather than leaving `provider_opts = {}` behind.
        let end = table_end(&lines, start);
        if patch.provider_opts.is_empty() {
            remove_field(&mut lines, start, end, "provider_opts");
        } else {
            let rendered = patch
                .provider_opts
                .iter()
                .map(|(key, value)| format!("{key} = {}", toml::Value::String(value.clone())))
                .collect::<Vec<_>>()
                .join(", ");
            set_raw_field(
                &mut lines,
                start,
                end,
                "provider_opts",
                &format!("{{ {rendered} }}"),
            )?;
        }
    }

    let mut patched = lines.join("\n");
    if had_trailing_newline {
        patched.push('\n');
    }
    RoleRegistry::from_toml(&patched).context("validating updated roles.toml")?;
    Ok(patched)
}

/// Replace a role's `tools` allow-list, keeping everything else in the file as it was.
///
/// Entries are Claude Code permission rules: a tool name (`Read`), a scoped rule
/// (`Bash(git *)`), or an MCP tool or server (`mcp__github`). Anything that could break
/// out of the TOML string or the CLI's comma-separated list is refused.
pub fn apply_tools_patch(source: &str, role_name: &str, tools: &[String]) -> Result<String> {
    for tool in tools {
        check_tool_rule(tool)?;
    }
    let mut lines: Vec<String> = source.lines().map(str::to_string).collect();
    let had_trailing_newline = source.ends_with('\n');
    let header = format!("[roles.{role_name}]");
    let start = lines
        .iter()
        .position(|line| line.trim() == header)
        .with_context(|| format!("roles.toml has no table `{header}`"))?;

    collapse_array(&mut lines, start, "tools");

    let end = table_end(&lines, start);
    let encoded = toml::Value::Array(
        tools
            .iter()
            .map(|tool| toml::Value::String(tool.clone()))
            .collect(),
    )
    .to_string();
    set_raw_field(&mut lines, start, end, "tools", &encoded)?;

    let mut patched = lines.join("\n");
    if had_trailing_newline {
        patched.push('\n');
    }
    RoleRegistry::from_toml(&patched).context("validating updated roles.toml")?;
    Ok(patched)
}

/// An array written over several lines: drop its continuation lines, so the single line
/// written in its place does not leave the old entries dangling.
fn collapse_array(lines: &mut Vec<String>, start: usize, key: &str) {
    let end = table_end(lines, start);
    if let Some(index) = find_field(lines, start, end, key) {
        let closes = |line: &str| {
            let code = match inline_comment(line) {
                Some(comment) => &line[..line.len() - comment.trim_start().len()],
                None => line,
            };
            code.contains(']')
        };
        if !closes(&lines[index]) {
            while index + 1 < lines.len() && !closes(&lines[index + 1]) {
                lines.remove(index + 1);
            }
            if index + 1 < lines.len() {
                lines.remove(index + 1);
            }
        }
    }
}

/// What the app's Checks and limits panel sets: the `[verify]` and `[limits]` blocks.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ChecksPatch {
    pub commands: Vec<String>,
    pub reviewer: Option<String>,
    pub escalate_to: Option<String>,
    pub timeout_secs: u64,
    pub max_parallel_workers: usize,
    pub worker_timeout_mins: u64,
    #[serde(default)]
    pub budget_tokens_5h: Option<u64>,
}

impl ChecksPatch {
    /// The panel's starting point: what the registry has now.
    pub fn from_registry(registry: &RoleRegistry) -> Self {
        Self {
            commands: registry.verify.commands.clone(),
            reviewer: registry.verify.reviewer.clone(),
            escalate_to: registry.verify.escalate_to.clone(),
            timeout_secs: registry.verify.timeout_secs,
            max_parallel_workers: registry.limits.max_parallel_workers,
            worker_timeout_mins: registry.limits.worker_timeout_mins,
            budget_tokens_5h: registry.limits.budget_tokens_5h,
        }
    }
}

/// Set `[verify]` and `[limits]` from the panel, keeping the rest of the file (comments
/// included) as it was. A block that isn't there is added at the end.
pub fn apply_checks_patch(source: &str, patch: &ChecksPatch) -> Result<String> {
    let commands: Vec<String> = patch
        .commands
        .iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    for command in &commands {
        if command.contains('\n') || command.contains('\r') {
            bail!("a check command must be one line");
        }
    }
    let mut lines: Vec<String> = source.lines().map(str::to_string).collect();
    let had_trailing_newline = source.ends_with('\n') || source.is_empty();

    let start = section(&mut lines, "verify");
    collapse_array(&mut lines, start, "commands");
    let end = table_end(&lines, start);
    let encoded = toml::Value::Array(commands.into_iter().map(toml::Value::String).collect());
    set_raw_field(&mut lines, start, end, "commands", &encoded.to_string())?;
    for (key, value) in [
        ("reviewer", &patch.reviewer),
        ("escalate_to", &patch.escalate_to),
    ] {
        let end = table_end(&lines, start);
        match value.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            Some(role) => set_string_field(&mut lines, start, end, key, role)?,
            None => remove_field(&mut lines, start, end, key),
        }
    }
    let end = table_end(&lines, start);
    set_raw_field(
        &mut lines,
        start,
        end,
        "timeout_secs",
        &patch.timeout_secs.to_string(),
    )?;

    let start = section(&mut lines, "limits");
    let end = table_end(&lines, start);
    set_raw_field(
        &mut lines,
        start,
        end,
        "max_parallel_workers",
        &patch.max_parallel_workers.to_string(),
    )?;
    let end = table_end(&lines, start);
    set_raw_field(
        &mut lines,
        start,
        end,
        "worker_timeout_mins",
        &patch.worker_timeout_mins.to_string(),
    )?;
    let end = table_end(&lines, start);
    match patch.budget_tokens_5h {
        Some(budget) => set_raw_field(
            &mut lines,
            start,
            end,
            "budget_tokens_5h",
            &budget.to_string(),
        )?,
        None => remove_field(&mut lines, start, end, "budget_tokens_5h"),
    }

    let mut patched = lines.join("\n");
    if had_trailing_newline {
        patched.push('\n');
    }
    RoleRegistry::from_toml(&patched).context("validating updated roles.toml")?;
    Ok(patched)
}

pub fn apply_checks_patch_file(path: &Path, patch: &ChecksPatch) -> Result<()> {
    let source =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let patched = apply_checks_patch(&source, patch)?;
    replace_file(path, &patched)
}

/// The line of a top-level `[name]` table, adding it at the end if there is none.
fn section(lines: &mut Vec<String>, name: &str) -> usize {
    let header = format!("[{name}]");
    if let Some(index) = lines.iter().position(|line| line.trim() == header) {
        return index;
    }
    if lines.last().is_some_and(|l| !l.trim().is_empty()) {
        lines.push(String::new());
    }
    lines.push(header);
    lines.len() - 1
}

fn check_tool_rule(tool: &str) -> Result<()> {
    let name = tool.split('(').next().unwrap_or_default();
    let valid_name = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    let valid_scope = match tool.find('(') {
        None => true,
        Some(open) => tool.ends_with(')') && open + 1 < tool.len() - 1,
    };
    let dangerous = tool.chars().any(|c| c == ',' || c == '"' || c.is_control());
    if !valid_name || !valid_scope || dangerous {
        bail!(
            "`{tool}` is not a tool rule — use a name like `Read`, `Bash(git *)` or `mcp__server`"
        );
    }
    Ok(())
}

pub fn apply_tools_patch_file(path: &Path, role_name: &str, tools: &[String]) -> Result<()> {
    let source =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let patched = apply_tools_patch(&source, role_name, tools)?;
    replace_file(path, &patched)
}

/// Where the role's table ends: the next table header, or end of file.
fn table_end(lines: &[String], table_start: usize) -> usize {
    lines[table_start + 1..]
        .iter()
        .position(|line| line.trim_start().starts_with('['))
        .map(|offset| table_start + 1 + offset)
        .unwrap_or(lines.len())
}

fn set_string_field(
    lines: &mut Vec<String>,
    table_start: usize,
    table_end: usize,
    key: &str,
    value: &str,
) -> Result<()> {
    if value.contains('\n') || value.contains('\r') {
        bail!("role field `{key}` cannot contain a newline");
    }
    let encoded = toml::Value::String(value.to_string()).to_string();
    set_raw_field(lines, table_start, table_end, key, &encoded)
}

/// Same, for a value that is already TOML source (an inline table, a number).
fn set_raw_field(
    lines: &mut Vec<String>,
    table_start: usize,
    table_end: usize,
    key: &str,
    encoded: &str,
) -> Result<()> {
    if let Some(index) = find_field(lines, table_start, table_end, key) {
        let indent: String = lines[index]
            .chars()
            .take_while(|c| c.is_whitespace())
            .collect();
        let comment = inline_comment(&lines[index]).unwrap_or_default();
        lines[index] = format!("{indent}{key} = {encoded}{comment}");
    } else {
        let insert_at = find_field(lines, table_start, table_end, "provider")
            .map(|index| index + 1)
            .unwrap_or(table_start + 1);
        lines.insert(insert_at, format!("{key} = {encoded}"));
    }
    Ok(())
}

fn remove_field(lines: &mut Vec<String>, table_start: usize, table_end: usize, key: &str) {
    if let Some(index) = find_field(lines, table_start, table_end, key) {
        lines.remove(index);
    }
}

fn find_field(lines: &[String], table_start: usize, table_end: usize, key: &str) -> Option<usize> {
    lines[table_start + 1..table_end]
        .iter()
        .position(|line| {
            let trimmed = line.trim_start();
            !trimmed.starts_with('#')
                && trimmed
                    .split_once('=')
                    .is_some_and(|(candidate, _)| candidate.trim() == key)
        })
        .map(|offset| table_start + 1 + offset)
}

fn inline_comment(line: &str) -> Option<String> {
    let mut quoted = false;
    let mut escaped = false;
    for (index, character) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' if quoted => escaped = true,
            '"' => quoted = !quoted,
            '#' if !quoted => return Some(format!(" {}", line[index..].trim_start())),
            _ => {}
        }
    }
    None
}

pub fn apply_role_patches_file(path: &Path, patches: &[RoleModelPatch]) -> Result<()> {
    let source =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let patched = apply_role_patches(&source, patches)?;
    replace_file(path, &patched)
}

/// Write beside the target and rename over it, so a crash never leaves half a file.
fn replace_file(path: &Path, patched: &str) -> Result<()> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("roles path has no filename")?;
    let temp_path = path.with_file_name(format!(".{file_name}.{}.tmp", std::process::id()));

    std::fs::write(&temp_path, patched)
        .with_context(|| format!("writing {}", temp_path.display()))?;
    if let Err(error) = std::fs::rename(&temp_path, path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error).with_context(|| format!("replacing {}", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = r#"# Fleet documentation stays.
[roles.builder]
provider = "claude"
model = "sonnet" # preferred default
isolation = "worktree"

# Local notes stay too.
[roles.local]
provider = "openai_compat"
base_url = "http://localhost:11434/v1"
model = "old"
isolation = "none"
"#;

    #[test]
    fn patches_only_requested_fields_and_preserves_comments() {
        let patched = apply_role_patches(
            SOURCE,
            &[RoleModelPatch {
                role_name: "local".into(),
                model: "qwen/qwen3-coder-30b".into(),
                base_url: Some("http://localhost:1234/v1".into()),
                provider: None,
                provider_opts: Default::default(),
            }],
        )
        .unwrap();

        assert!(patched.contains("# Fleet documentation stays."));
        assert!(patched.contains("# Local notes stay too."));
        assert!(patched.contains("model = \"sonnet\" # preferred default"));
        assert!(patched.contains("base_url = \"http://localhost:1234/v1\""));
        assert!(patched.contains("model = \"qwen/qwen3-coder-30b\""));
    }

    #[test]
    fn inserts_missing_model_after_provider() {
        let source = r#"[roles.x]
provider = "claude"
isolation = "readonly"
"#;
        let patched = apply_role_patches(
            source,
            &[RoleModelPatch {
                role_name: "x".into(),
                model: "opus".into(),
                base_url: None,
                provider: None,
                provider_opts: Default::default(),
            }],
        )
        .unwrap();
        assert!(patched.contains("provider = \"claude\"\nmodel = \"opus\"\nisolation"));
    }

    #[test]
    fn a_provider_swap_rewrites_provider_and_adds_its_options() {
        let patched = apply_role_patches(
            SOURCE,
            &[RoleModelPatch {
                role_name: "builder".into(),
                model: "qwen/qwen3-coder-30b".into(),
                base_url: None,
                provider: Some("codex".into()),
                provider_opts: std::collections::BTreeMap::from([(
                    "model_provider".to_string(),
                    "lmstudio".to_string(),
                )]),
            }],
        )
        .unwrap();

        assert!(patched.contains("provider = \"codex\""));
        assert!(patched.contains("model = \"qwen/qwen3-coder-30b\""));
        assert!(
            patched.contains("provider_opts = { model_provider = \"lmstudio\" }"),
            "got: {patched}"
        );
        // Policy and documentation are not the model picker's business.
        assert!(patched.contains("isolation = \"worktree\""));
        assert!(patched.contains("# Fleet documentation stays."));
    }

    #[test]
    fn swapping_back_clears_the_options_the_old_backend_needed() {
        let source = r#"[roles.builder]
provider = "codex"
model = "qwen"
isolation = "worktree"
provider_opts = { model_provider = "lmstudio" }
"#;
        let patched = apply_role_patches(
            source,
            &[RoleModelPatch {
                role_name: "builder".into(),
                model: "sonnet".into(),
                base_url: None,
                provider: Some("claude".into()),
                provider_opts: Default::default(),
            }],
        )
        .unwrap();

        // A leftover `model_provider` would send the Claude CLI a flag it cannot use.
        assert!(!patched.contains("provider_opts"), "got: {patched}");
        assert!(patched.contains("provider = \"claude\""));
        assert!(patched.contains("model = \"sonnet\""));
    }

    #[test]
    fn refuses_unknown_roles_without_touching_source() {
        let error = apply_role_patches(
            SOURCE,
            &[RoleModelPatch {
                role_name: "missing".into(),
                model: "opus".into(),
                base_url: None,
                provider: None,
                provider_opts: Default::default(),
            }],
        )
        .unwrap_err();
        assert!(error.to_string().contains("no table"));
    }

    #[test]
    fn a_tools_edit_rewrites_the_list_and_keeps_the_comments() {
        let source = "# fleet\n[roles.builder]\nprovider = \"claude\"\ntools = [\"Read\"] # keep me\nmax_turns = 5\n\n[roles.other]\nprovider = \"mock\"\n";
        let tools = vec![
            "Read".to_string(),
            "Bash(git *)".to_string(),
            "mcp__github".to_string(),
        ];
        let patched = apply_tools_patch(source, "builder", &tools).unwrap();
        assert!(
            patched.contains("tools = [\"Read\", \"Bash(git *)\", \"mcp__github\"] # keep me"),
            "{patched}"
        );
        assert!(patched.starts_with("# fleet\n"));
        let registry = RoleRegistry::from_toml(&patched).unwrap();
        assert_eq!(registry.roles["builder"].tools, tools);
        assert!(
            registry.roles["other"].tools.is_empty(),
            "other roles untouched"
        );
    }

    #[test]
    fn a_multiline_tools_array_is_replaced_whole() {
        let source = "[roles.builder]\nprovider = \"claude\"\ntools = [\n  \"Read\",\n  \"Write\", # edits\n]\nmax_turns = 5\n";
        let patched = apply_tools_patch(source, "builder", &["Grep".to_string()]).unwrap();
        let registry = RoleRegistry::from_toml(&patched).unwrap();
        assert_eq!(registry.roles["builder"].tools, ["Grep"]);
        assert_eq!(registry.roles["builder"].max_turns, Some(5));
        assert!(!patched.contains("Write"), "{patched}");
    }

    #[test]
    fn tools_are_added_to_a_role_that_had_none() {
        let source = "[roles.builder]\nprovider = \"claude\"\n";
        let patched = apply_tools_patch(source, "builder", &["Read".to_string()]).unwrap();
        assert_eq!(
            RoleRegistry::from_toml(&patched).unwrap().roles["builder"].tools,
            ["Read"]
        );
    }

    #[test]
    fn a_tool_rule_that_could_escape_is_refused() {
        let source = "[roles.builder]\nprovider = \"claude\"\n";
        for bad in [
            "",
            "Read,Write",
            "Bash(",
            "Bash()",
            "a\"b",
            "Read\nWrite",
            "has space",
        ] {
            assert!(
                apply_tools_patch(source, "builder", &[bad.to_string()]).is_err(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn checks_and_limits_are_set_without_touching_the_rest() {
        let source = "default_role = \"builder\"\n\n# my fleet\n[roles.builder]\nprovider = \"mock\"\nisolation = \"worktree\"\n\n[roles.tester]\nprovider = \"mock\"\nisolation = \"readonly\"\n\n[verify]\ncommands = [\n  \"old one\",\n]  # keep this note\n";
        let patch = ChecksPatch {
            commands: vec!["cargo test".into(), "  ".into()],
            reviewer: Some("tester".into()),
            escalate_to: None,
            timeout_secs: 600,
            max_parallel_workers: 2,
            worker_timeout_mins: 45,
            budget_tokens_5h: Some(2_000_000),
        };
        let patched = apply_checks_patch(source, &patch).unwrap();
        assert!(patched.contains("# my fleet"), "{patched}");
        let registry = RoleRegistry::from_toml(&patched).unwrap();
        assert_eq!(registry.verify.commands, ["cargo test"]);
        assert_eq!(registry.verify.reviewer.as_deref(), Some("tester"));
        assert_eq!(registry.verify.timeout_secs, 600);
        assert_eq!(registry.limits.max_parallel_workers, 2);
        assert_eq!(registry.limits.worker_timeout_mins, 45);
        assert_eq!(registry.limits.budget_tokens_5h, Some(2_000_000));
        assert!(!patched.contains("old one"));
        assert_eq!(
            ChecksPatch::from_registry(&registry).commands,
            ["cargo test"]
        );

        // Clearing the reviewer removes the line; a reviewer that isn't a role is refused.
        let cleared = apply_checks_patch(
            &patched,
            &ChecksPatch {
                reviewer: None,
                ..patch.clone()
            },
        )
        .unwrap();
        assert!(RoleRegistry::from_toml(&cleared)
            .unwrap()
            .verify
            .reviewer
            .is_none());
        assert!(apply_checks_patch(
            source,
            &ChecksPatch {
                reviewer: Some("nobody".into()),
                ..patch.clone()
            }
        )
        .is_err());
        assert!(apply_checks_patch(
            source,
            &ChecksPatch {
                max_parallel_workers: 0,
                ..patch
            }
        )
        .is_err());
    }
}
