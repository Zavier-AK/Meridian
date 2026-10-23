import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { pluginTitle, type Plugin } from "./types";

type Props = {
  /** Hand the head agent a request to build one. */
  onMakePlugin: (description: string) => void;
};

function contributions(plugin: Plugin): string {
  const m = plugin.manifest;
  if (!m) return "";
  const count = (n: number, one: string) => (n ? `${n} ${one}${n === 1 ? "" : "s"}` : null);
  return [
    count(plugin.skills.length, "skill"),
    count(Object.keys(m.mcp_servers).length, "agent tool"),
    count(m.commands.length, "command"),
    count(m.hooks.length, "hook"),
    count(m.panels.length, "panel"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Everything turning a plugin on lets it run, to read before saying yes. */
function WhatItRuns({ plugin }: { plugin: Plugin }) {
  const m = plugin.manifest;
  if (!m) return null;
  const runs = m.commands.filter((c) => c.run);
  const servers = Object.entries(m.mcp_servers);
  return (
    <div className="plugin-approval">
      {runs.length > 0 && (
        <>
          <span className="settings-meta">Commands, when you click them:</span>
          <ul>
            {runs.map((c) => (
              <li key={c.id}>
                <b>{c.title}</b> <code>{c.run}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {m.hooks.length > 0 && (
        <>
          <span className="settings-meta">Hooks, by themselves:</span>
          <ul>
            {m.hooks.map((h, i) => (
              <li key={i}>
                on {h.on.join(", ")}: <code>{h.run}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {servers.length > 0 && (
        <>
          <span className="settings-meta">Tools for every agent:</span>
          <ul>
            {servers.map(([name, config]) => (
              <li key={name}>
                <b>{name}</b>{" "}
                <code>{config.command ? [config.command, ...(config.args ?? [])].join(" ") : config.url}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {plugin.skills.length > 0 && (
        <span className="settings-meta">Skills: {plugin.skills.join(", ")}</span>
      )}
      {m.panels.length > 0 && (
        <span className="settings-meta">
          Panels ({m.panels.map((p) => p.title).join(", ")}) run in a sandbox and can run only the commands above.
        </span>
      )}
      <span className="settings-meta muted">From {plugin.dir}</span>
    </div>
  );
}

/**
 * Tools & Skills → Plugins. Turning one on approves it exactly as it is now: if its files
 * change, it's off again until approved again.
 */
export default function PluginsSection({ onMakePlugin }: Props) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [idea, setIdea] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    invoke<Plugin[]>("plugins_list")
      .then(setPlugins)
      .catch((err) => setMessage({ ok: false, text: String(err) }));
  }, []);

  useEffect(() => {
    load();
    const off = listen<string>("harness://changed", ({ payload }) => {
      if (payload === "plugins") load();
    });
    return () => void off.then((f) => f());
  }, [load]);

  async function setEnabled(plugin: Plugin, enabled: boolean) {
    setMessage(null);
    try {
      await invoke<Plugin>("plugin_set_enabled", { key: plugin.key, enabled });
      setReviewing(null);
      setMessage({
        ok: true,
        text: enabled
          ? `${pluginTitle(plugin)} is on. Workers get its skills and tools on their next task; the head agent when the project is next opened.`
          : `${pluginTitle(plugin)} is off.`,
      });
      load();
    } catch (err) {
      setMessage({ ok: false, text: String(err) });
    }
  }

  async function install(from: string) {
    setBusy(true);
    setMessage(null);
    try {
      const names = await invoke<string[]>("plugin_install", { source: from });
      setMessage({ ok: true, text: `Installed ${names.join(", ")}. Review it below, then turn it on.` });
      setSource("");
      load();
    } catch (err) {
      setMessage({ ok: false, text: String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function installFolder() {
    const picked = await open({ directory: true, multiple: false, title: "Choose a plugin folder" });
    if (typeof picked === "string") await install(picked);
  }

  return (
    <div className="settings-section plugins-section">
      <h3>Plugins</h3>
      <p className="muted">
        A plugin adds skills, tools for the agents, one-click commands, hooks that run when
        something happens, or a tab of its own. Installed plugins apply to every project; a
        project's own live in its <code>.meridian/plugins/</code>. Nothing a plugin declares
        runs until you turn it on, and if it changes, it's off again until you approve it again.
      </p>

      {message && <p className={`settings-meta ${message.ok ? "ok" : "error"}`}>{message.text}</p>}

      {plugins.length === 0 ? (
        <p className="muted">No plugins yet. Install one, or describe one below and an agent will build it.</p>
      ) : (
        <ul className="settings-list">
          {plugins.map((plugin) => (
            <li key={plugin.key} className={`plugin-row ${plugin.state}`}>
              <div className="plugin-row-head">
                <span className="settings-name">{pluginTitle(plugin)}</span>
                <span className="pill">{plugin.scope === "project" ? "this project" : "all projects"}</span>
                {plugin.manifest?.version && <span className="muted mono plugin-version">{plugin.manifest.version}</span>}
                <span className="plugin-row-actions">
                  {plugin.state === "on" && (
                    <button className="ghost" onClick={() => void setEnabled(plugin, false)}>
                      Turn off
                    </button>
                  )}
                  {(plugin.state === "off" || plugin.state === "changed") && (
                    <button
                      className={reviewing === plugin.key ? "ghost" : ""}
                      onClick={() => setReviewing(reviewing === plugin.key ? null : plugin.key)}
                    >
                      {reviewing === plugin.key ? "Cancel" : plugin.state === "changed" ? "Review again" : "Review and turn on"}
                    </button>
                  )}
                  {plugin.scope === "installed" && (
                    <button
                      className="ghost danger"
                      onClick={() =>
                        void invoke("plugin_uninstall", { name: plugin.manifest?.name ?? plugin.key.split(":")[1] })
                          .then(load)
                          .catch((err) => setMessage({ ok: false, text: String(err) }))
                      }
                    >
                      Remove
                    </button>
                  )}
                </span>
              </div>
              {plugin.manifest?.description && <span className="settings-desc">{plugin.manifest.description}</span>}
              <span className="settings-meta">
                {plugin.state === "on" && <span className="ok-text">On · </span>}
                {plugin.state === "changed" && <span className="warn-text">Changed since you approved it · </span>}
                {contributions(plugin)}
              </span>
              {plugin.state === "broken" && <span className="settings-meta error">{plugin.error}</span>}
              {reviewing === plugin.key && (
                <>
                  <WhatItRuns plugin={plugin} />
                  <button className="primary" onClick={() => void setEnabled(plugin, true)}>
                    Approve and turn on
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="settings-actions">
        <button onClick={() => void installFolder()} disabled={busy}>
          Install a folder…
        </button>
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (source.trim()) void install(source.trim());
          }}
        >
          <input
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="https://github.com/owner/meridian-plugin"
            aria-label="Git repository to install a plugin from"
            spellCheck={false}
          />
          <button type="submit" disabled={!source.trim() || busy}>
            {busy ? "Installing…" : "Install from Git"}
          </button>
        </form>
      </div>

      <form
        className="inline-form make-plugin"
        onSubmit={(event) => {
          event.preventDefault();
          if (idea.trim()) {
            onMakePlugin(idea.trim());
            setIdea("");
          }
        }}
      >
        <input
          className="grow"
          value={idea}
          onChange={(event) => setIdea(event.target.value)}
          placeholder="Describe a plugin: “a tab showing failing tests, with a button to rerun them”"
          aria-label="Describe a plugin to build"
        />
        <button type="submit" disabled={!idea.trim()}>
          Make it
        </button>
      </form>
    </div>
  );
}
