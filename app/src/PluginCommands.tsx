import { useEffect, useRef, useState } from "react";
import { pluginTitle, type Plugin, type PluginCommandSpec } from "./types";

type Props = {
  plugins: Plugin[];
  onCommand: (plugin: Plugin, command: PluginCommandSpec) => void;
};

/** The chat box's plugin button: every command the project's plugins offer. */
export default function PluginCommands({ plugins, onCommand }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const entries = plugins.flatMap((plugin) =>
    (plugin.manifest?.commands ?? []).map((command) => ({ plugin, command })),
  );

  useEffect(() => {
    if (!open) return;
    function close(event: MouseEvent) {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  if (entries.length === 0) return null;

  return (
    <div className="plugin-commands" ref={root}>
      <button
        type="button"
        className={`composer-pill ${open ? "open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Plugin commands"
      >
        {/* A puzzle piece. */}
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M6 2.5h1.2a1.4 1.4 0 1 1 2.6 0H11a.5.5 0 0 1 .5.5v2a1.4 1.4 0 1 1 0 2.6V10a.5.5 0 0 1-.5.5H9.8a1.4 1.4 0 1 0-2.6 0H6a.5.5 0 0 1-.5-.5V7.6a1.4 1.4 0 1 0 0-2.6V3a.5.5 0 0 1 .5-.5z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
        <span>Plugins</span>
      </button>
      {open && (
        <ul className="plugin-commands-menu" role="menu">
          {entries.map(({ plugin, command }) => (
            <li key={`${plugin.key}#${command.id}`}>
              <button
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onCommand(plugin, command);
                }}
                title={command.run ? `Runs: ${command.run}` : `Puts in the chat box: ${command.prompt}`}
              >
                <span className="plugin-command-title">{command.title}</span>
                <span className="muted plugin-command-meta">
                  {pluginTitle(plugin)} · {command.run ? "runs" : "prompt"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
