import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PluginCommandOutput, ProjectHarnessEvent } from "./types";

/** What a panel can read about the project. Kept small and plain: it's handed to code
 * the person approved, but code all the same. */
export type PanelContext = {
  project: { root: string; name: string };
  workers: {
    id: string;
    number?: number;
    role: string;
    status: string;
    summary: string;
    branch: string | null;
    files: number | null;
  }[];
  repos: { path: string; name: string; branch: string | null; ahead: number; behind: number; changed: number }[];
};

type Props = {
  projectRoot: string;
  pluginKey: string;
  panelId: string;
  title: string;
  context: () => PanelContext;
  /** Put text in the chat box. */
  onAsk: (text: string) => void;
};

type Call = { meridianCall: string; id: number; args?: Record<string, unknown> };

/**
 * A plugin's panel, in a sandboxed frame: scripts run, but with an opaque origin and no
 * way to the app. Everything it can do goes through the messages handled here — read the
 * project's state, run its own plugin's commands, put text in the chat box — and it is
 * sent this project's events as they happen.
 */
export default function PluginPanel({ projectRoot, pluginKey, panelId, title, context, onAsk }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The handlers below outlive renders; read the latest of these through refs.
  const contextRef = useRef(context);
  contextRef.current = context;
  const askRef = useRef(onAsk);
  askRef.current = onAsk;

  useEffect(() => {
    setSrc(null);
    setError(null);
    invoke<string>("plugin_panel", { key: pluginKey, panel: panelId })
      .then((path) => setSrc(convertFileSrc("", "meridian-plugin") + path))
      .catch((err) => setError(String(err)));
  }, [projectRoot, pluginKey, panelId]);

  useEffect(() => {
    function reply(id: number, result?: unknown, error?: string) {
      frame.current?.contentWindow?.postMessage({ meridianReply: true, id, result, error }, "*");
    }
    function onMessage(event: MessageEvent) {
      // Only this panel's own frame is answered.
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const message = event.data as Call;
      if (!message || typeof message.meridianCall !== "string" || typeof message.id !== "number") return;
      const args = message.args ?? {};
      switch (message.meridianCall) {
        case "context":
          reply(message.id, contextRef.current());
          break;
        case "run":
          invoke<PluginCommandOutput>("plugin_run_command", { key: pluginKey, command: String(args.id ?? "") })
            .then((output) => reply(message.id, output))
            .catch((err) => reply(message.id, undefined, String(err)));
          break;
        case "ask":
          askRef.current(String(args.text ?? "").slice(0, 4000));
          reply(message.id, true);
          break;
        default:
          reply(message.id, undefined, `unknown call ${message.meridianCall}`);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [pluginKey]);

  useEffect(() => {
    const off = listen<ProjectHarnessEvent>("harness://event", ({ payload }) => {
      if (payload.project !== projectRoot) return;
      frame.current?.contentWindow?.postMessage({ meridianEvent: payload }, "*");
    });
    return () => void off.then((stop) => stop());
  }, [projectRoot]);

  if (error) {
    return <p className="error plugin-panel-error">{error}</p>;
  }
  return src ? (
    <iframe
      ref={frame}
      className="plugin-frame"
      title={title}
      src={src}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
    />
  ) : (
    <p className="muted plugin-panel-error">Loading {title}…</p>
  );
}
