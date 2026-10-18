import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChangeGroup, FileChange, Worker } from "./types";

type Props = {
  workers: Record<string, Worker>;
  /** Bumped when something that changes code happened, so the overview is re-read. */
  refreshKey: number;
  onSelectWorker: (id: string) => void;
};

const STATE_LABEL: Record<ChangeGroup["state"], string> = {
  working: "writing",
  review: "in review",
  kept: "on its branch",
  landed: "landed",
  uncommitted: "uncommitted",
};

/** Five little blocks, like a pull request's: green for added, red for removed. */
function Blocks({ insertions, deletions }: { insertions: number; deletions: number }) {
  const total = insertions + deletions;
  let green = total === 0 ? 0 : Math.round((insertions / total) * 5);
  let red = total === 0 ? 0 : 5 - green;
  // Both kinds present: each gets at least one block.
  if (insertions > 0 && green === 0) [green, red] = [1, 4];
  if (deletions > 0 && red === 0) [green, red] = [4, 1];
  return (
    <span className="change-blocks" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={i < green ? "add" : i < green + red ? "del" : ""} />
      ))}
    </span>
  );
}

function Counts({ insertions, deletions, binary }: { insertions: number; deletions: number; binary?: boolean }) {
  if (binary) return <span className="change-counts muted">binary</span>;
  return (
    <span className="change-counts">
      <span className="ins">+{insertions}</span> <span className="del">−{deletions}</span>
    </span>
  );
}

function splitPath(path: string): [string, string] {
  const at = path.lastIndexOf("/");
  return at < 0 ? ["", path] : [path.slice(0, at + 1), path.slice(at + 1)];
}

type FileRow = FileChange & { sources: { group: ChangeGroup; change: FileChange }[] };

/**
 * Everything this session changed in the code, file by file: what workers are writing,
 * what waits for review, what landed, and what's uncommitted in the checkout.
 */
export default function ChangesPanel({ workers, refreshKey, onSelectWorker }: Props) {
  const [groups, setGroups] = useState<ChangeGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"file" | "agent">("file");
  const working = groups?.some((group) => group.state === "working") ?? false;

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      invoke<ChangeGroup[]>("changes_overview")
        .then((found) => {
          if (cancelled) return;
          setGroups(found);
          setError(null);
        })
        .catch((err) => !cancelled && setError(String(err)));
    void load();
    // While a worker is writing, its numbers move on their own.
    const timer = working ? setInterval(() => void load(), 4000) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [refreshKey, working]);

  const files = useMemo<FileRow[]>(() => {
    const byPath = new Map<string, FileRow>();
    for (const group of groups ?? []) {
      for (const change of group.files) {
        const row = byPath.get(change.path);
        if (row) {
          row.insertions += change.insertions;
          row.deletions += change.deletions;
          row.binary ||= change.binary;
          row.added ||= change.added;
          row.sources.push({ group, change });
        } else {
          byPath.set(change.path, { ...change, sources: [{ group, change }] });
        }
      }
    }
    return [...byPath.values()].sort(
      (a, b) => b.insertions + b.deletions - (a.insertions + a.deletions) || a.path.localeCompare(b.path),
    );
  }, [groups]);

  const insertions = files.reduce((sum, f) => sum + f.insertions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const byState = new Map<string, number>();
  for (const group of groups ?? []) byState.set(group.state, (byState.get(group.state) ?? 0) + 1);

  const who = (group: ChangeGroup) => {
    if (!group.worker_id) return "Checkout";
    const worker = workers[group.worker_id];
    return `${worker?.number ? `#${worker.number} ` : ""}${group.role ?? worker?.role ?? "worker"}`;
  };

  if (error) return <p className="error changes-empty">{error}</p>;
  if (!groups) return <p className="muted changes-empty">Reading changes…</p>;
  if (files.length === 0) {
    return (
      <div className="changes-empty">
        <p className="muted">No changes yet.</p>
        <p className="muted small">Files the workers touch show up here as they write them.</p>
      </div>
    );
  }

  const total = insertions + deletions || 1;
  return (
    <div className="changes">
      <div className="changes-summary">
        <div className="changes-total">
          <span className="changes-files">
            {files.length} file{files.length === 1 ? "" : "s"}
          </span>
          <Counts insertions={insertions} deletions={deletions} />
        </div>
        <div className="changes-bar" aria-hidden>
          <span className="ins" style={{ width: `${(insertions / total) * 100}%` }} />
          <span className="del" style={{ width: `${(deletions / total) * 100}%` }} />
        </div>
        <div className="changes-states">
          {[...byState].map(([state, count]) => (
            <span key={state} className={`change-state ${state}`}>
              {count} {STATE_LABEL[state as ChangeGroup["state"]]}
            </span>
          ))}
        </div>
      </div>

      <div className="changes-mode" role="tablist" aria-label="Group changes">
        <button role="tab" aria-selected={mode === "file"} className={mode === "file" ? "active" : ""} onClick={() => setMode("file")}>
          By file
        </button>
        <button role="tab" aria-selected={mode === "agent"} className={mode === "agent" ? "active" : ""} onClick={() => setMode("agent")}>
          By agent
        </button>
      </div>

      {mode === "file" ? (
        <ul className="change-list">
          {files.map((file) => {
            const [dir, name] = splitPath(file.path);
            const workerSource = file.sources.find((s) => s.group.worker_id);
            return (
              <li key={file.path}>
                <button
                  className="change-row"
                  onClick={() => workerSource?.group.worker_id && onSelectWorker(workerSource.group.worker_id)}
                  disabled={!workerSource}
                  title={file.path}
                >
                  <span className="change-path">
                    <span className="change-name">
                      {name}
                      {file.added && <span className="change-new">new</span>}
                    </span>
                    {dir && <span className="change-dir">{dir}</span>}
                  </span>
                  <span className="change-right">
                    <Counts insertions={file.insertions} deletions={file.deletions} binary={file.binary} />
                    <Blocks insertions={file.insertions} deletions={file.deletions} />
                  </span>
                  <span className="change-who">
                    {file.sources.map(({ group }) => (
                      <span key={group.worker_id ?? "checkout"} className={`change-state ${group.state}`}>
                        {who(group)} · {STATE_LABEL[group.state]}
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="change-groups">
          {groups.map((group) => {
            const ins = group.files.reduce((sum, f) => sum + f.insertions, 0);
            const del = group.files.reduce((sum, f) => sum + f.deletions, 0);
            return (
              <section key={group.worker_id ?? "checkout"} className={`change-group ${group.state}`}>
                <button
                  className="change-group-head"
                  onClick={() => group.worker_id && onSelectWorker(group.worker_id)}
                  disabled={!group.worker_id}
                >
                  <span className="change-group-who">{who(group)}</span>
                  <span className={`change-state ${group.state}`}>{STATE_LABEL[group.state]}</span>
                  <Counts insertions={ins} deletions={del} />
                </button>
                <ul className="change-list compact">
                  {group.files.map((file) => {
                    const [dir, name] = splitPath(file.path);
                    return (
                      <li key={file.path} className="change-row static" title={file.path}>
                        <span className="change-path">
                          <span className="change-name">
                            {name}
                            {file.added && <span className="change-new">new</span>}
                          </span>
                          {dir && <span className="change-dir">{dir}</span>}
                        </span>
                        <span className="change-right">
                          <Counts insertions={file.insertions} deletions={file.deletions} binary={file.binary} />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
