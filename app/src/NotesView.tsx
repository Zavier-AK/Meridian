import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { NoteInfo, NotesListing } from "./types";

type Props = {
  /** Which note to open first. */
  initialPath: string | null;
  onClose: () => void;
};

function ago(unix: number): string {
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 129_600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

const GROUPS: { label: string; match: (path: string) => boolean }[] = [
  { label: "About you", match: (p) => p === "me.md" },
  { label: "Projects", match: (p) => p.startsWith("projects/") },
  { label: "Topics", match: (p) => p.startsWith("topics/") },
  { label: "Other", match: (p) => !["me.md", "README.md"].includes(p) && !/^(projects|topics)\//.test(p) },
];

/**
 * The notes folder: what agents have learned, kept between projects. Plain markdown the
 * person can read, edit and delete; agents only add to it, and only a little.
 */
export default function NotesView({ initialPath, onClose }: Props) {
  const [listing, setListing] = useState<NotesListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialPath);
  const [text, setText] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  const load = useCallback(() => {
    invoke<NotesListing>("notes_list")
      .then((l) => {
        setListing(l);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    load();
    const off = listen<string>("harness://changed", ({ payload }) => {
      if (payload === "notes") load();
    });
    // An agent's write lands while this is open.
    const offEvents = listen<{ type: string }>("harness://event", ({ payload }) => {
      if (payload.type === "note_written") load();
    });
    return () => {
      void off.then((f) => f());
      void offEvents.then((f) => f());
    };
  }, [load]);

  useEffect(() => {
    if (!selected && listing) {
      const first = listing.notes.find((n) => n.path === "me.md") ?? listing.notes[0];
      if (first) setSelected(first.path);
    }
  }, [listing, selected]);

  useEffect(() => {
    setDraft(null);
    setText(null);
    if (!selected) return;
    invoke<string>("note_read", { path: selected })
      .then(setText)
      .catch((err) => setText(`Couldn't read it: ${String(err)}`));
  }, [selected, listing]);

  const groups = useMemo(
    () =>
      GROUPS.map((g) => ({
        label: g.label,
        notes: (listing?.notes ?? []).filter((n: NoteInfo) => g.match(n.path)),
      })).filter((g) => g.notes.length > 0),
    [listing],
  );

  async function save() {
    if (!selected || draft === null) return;
    try {
      await invoke("note_save", { path: selected, content: draft });
      setDraft(null);
      load();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <section className="notes-view" aria-label="Notes">
      <header className="settings-head">
        <h2>Notes</h2>
        <span className="github-head-actions">
          <button className="ghost" onClick={() => void invoke("notes_open", { path: null, obsidian: false }).catch((e) => setError(String(e)))}>
            Show folder
          </button>
          <button className="ghost" onClick={() => void invoke("notes_open", { path: selected, obsidian: true }).catch((e) => setError(String(e)))}>
            Open in Obsidian
          </button>
          <button className="ghost" onClick={onClose} title="Back to the session (Esc)">
            Done
          </button>
        </span>
      </header>
      <p className="muted notes-intro">
        What agents learn here, they can find again in the next project. Only <code>me.md</code> and the
        current project's note are given to the head agent up front, and only their first part; the rest
        it searches when it's relevant. {listing && <span className="mono">{listing.folder}</span>}
      </p>
      {error && <p className="error">{error}</p>}

      <div className="notes-body">
        <nav className="notes-list" aria-label="Notes">
          {groups.map((group) => (
            <div key={group.label} className="notes-group">
              <span className="notes-group-label">{group.label}</span>
              {group.notes.map((note) => (
                <button
                  key={note.path}
                  className={`notes-item ${selected === note.path ? "active" : ""}`}
                  onClick={() => setSelected(note.path)}
                  title={note.path}
                >
                  <span className="notes-item-title">{note.title}</span>
                  <span className="muted notes-item-meta">{ago(note.modified)}</span>
                </button>
              ))}
            </div>
          ))}
          {listing && groups.length === 0 && (
            <p className="muted notes-empty">No notes yet. They appear as agents learn things worth keeping.</p>
          )}
        </nav>

        <article className="notes-page">
          {selected && (
            <div className="notes-page-head">
              <span className="mono muted">{selected}</span>
              {draft === null ? (
                <button onClick={() => setDraft(text ?? "")} disabled={text === null}>
                  Edit
                </button>
              ) : (
                <span className="github-head-actions">
                  <button className="ghost" onClick={() => setDraft(null)}>
                    Cancel
                  </button>
                  <button className="primary" onClick={() => void save()}>
                    Save
                  </button>
                </span>
              )}
            </div>
          )}
          {draft !== null ? (
            <textarea
              className="notes-editor mono"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              aria-label={`Edit ${selected}`}
            />
          ) : text !== null ? (
            <div className="notes-rendered markdown">
              <Markdown remarkPlugins={[remarkGfm]}>{text.replace(/<!--[\s\S]*?-->/g, "")}</Markdown>
            </div>
          ) : (
            selected && <p className="muted">Reading…</p>
          )}
        </article>
      </div>
    </section>
  );
}
