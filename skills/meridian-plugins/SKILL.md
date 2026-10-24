---
name: meridian-plugins
description: Make or change a Meridian plugin — a folder in .meridian/plugins/<name>/ with a meridian-plugin.toml that adds skills, agent tools (MCP servers), one-click commands, hooks on events, or a panel tab. Use when asked to build, extend or fix a plugin for Meridian.
---

# Making a Meridian plugin

A plugin is a folder at `.meridian/plugins/<name>/` in the project. `<name>` is lower-case
letters, digits and dashes, and must equal `name` in the manifest. Nothing in it runs until
the person turns it on in Tools & Skills, and any later change turns it off again until they
approve it once more. So write it completely, and say what it will run.

## meridian-plugin.toml

```toml
name = "lint-guard"                 # = the folder name
title = "Lint guard"
version = "0.1.0"
description = "One line: what it's for."

# A button in the chat box. Exactly one of `run` (a shell command, run in the project
# folder) or `prompt` (text put in the chat box for the person to send).
[[commands]]
id = "lint"                          # letters, digits, - and _
title = "Run lint"
run = "npm run lint"
timeout_secs = 120                   # optional, default 120

[[commands]]
id = "fix"
title = "Fix lint errors"
prompt = "Have a builder fix the lint errors from the last run."

# Run when something happens. The event arrives as JSON on stdin; its `type` is one of
# worker_spawned, worker_finished, merge_requested, merge_landed, merge_reverted,
# verification_finished, plan_finished, pull_request_opened, run_finished.
[[hooks]]
on = ["merge_landed"]
run = "sh \"$MERIDIAN_PLUGIN_DIR/hooks/notify.sh\""
                                     # commands run in the project folder;
                                     # $MERIDIAN_PLUGIN_DIR is this folder,
                                     # $MERIDIAN_PLUGIN_DATA is where to keep state
timeout_secs = 60

# A tab in the session.
[[panels]]
id = "report"
title = "Lint"
entry = "panel/index.html"           # inside this folder

# Tools for every agent, in Claude Code's mcpServers shape. Named <plugin>-<server>.
[mcp_servers.eslint]
command = "npx"
args = ["-y", "some-eslint-mcp"]
```

Skills go in `skills/<skill-name>/SKILL.md`, with the usual `name` and `description`
front matter. Agents see them as `<plugin>-<skill-name>`.

## Panels

A panel is a page in a sandboxed frame: scripts run, but it has no access to the app, to
cookies, or to other pages. Keep it to one HTML file with inline CSS and JS, or files
beside it. Load `__meridian.js` (served next to every panel) and use:

```html
<script src="__meridian.js"></script>
<script>
  const ctx = await Meridian.context();   // { project: {root, name}, workers: [...], repos: [...] }
  Meridian.on((event) => { /* every engine event, as JSON with a `type` */ });
  await Meridian.run("lint");             // one of this plugin's `run` commands → { exit_code, output }
  Meridian.ask("Review the failing tests"); // puts text in the chat box; the person sends it
</script>
```

Match the app: dark background `#1b151e`, text `#f5eaef`, muted `#b09aa5`, accent
`#ff9ebb`, 13px system font, 12px radius.

## Before you finish

- `name` matches the folder; every `id` is unique; every `entry` exists.
- Commands are safe to run twice and say what they did.
- Keep state in `$MERIDIAN_PLUGIN_DATA`, never in the plugin folder: changing the plugin's
  own files turns it off until the person approves it again. Don't write into the project
  either, unless that's the point of the command.
- Tell the person what the plugin runs (commands, hooks, servers), so they know what
  they're approving.
