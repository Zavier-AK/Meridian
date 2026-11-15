import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Mirrors `harness_core::roles_patch::ChecksPatch`. */
type Checks = {
  commands: string[];
  reviewer: string | null;
  escalate_to: string | null;
  timeout_secs: number;
  max_parallel_workers: number;
  worker_timeout_mins: number;
  budget_tokens_5h: number | null;
};

type View = { checks: Checks; roles: string[] };

/**
 * The project's `[verify]` and `[limits]`, editable without opening `roles.toml`.
 *
 * Checks are what make the autonomy slider's "Land safe" and "Land most" do anything: a
 * change nothing checked never lands by itself. So this sits beside the fleet, where the
 * roles a reviewer can be are listed.
 */
export default function ChecksPanel({ projectRoot }: { projectRoot: string }) {
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Checks | null>(null);
  const [commands, setCommands] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<View>("checks_settings", { projectRoot })
      .then((loaded) => {
        setView(loaded);
        setDraft(loaded.checks);
        setCommands(loaded.checks.commands.join("\n"));
      })
      .catch((err) => setError(String(err)));
  }, [projectRoot]);

  if (!draft || !view) {
    return error ? <p className="error">{error}</p> : null;
  }

  const update = (patch: Partial<Checks>) => {
    setDraft({ ...draft, ...patch });
    setStatus(null);
  };

  async function save() {
    if (!draft) return;
    setError(null);
    try {
      const saved = await invoke<View>("save_checks_settings", {
        projectRoot,
        checks: { ...draft, commands: commands.split("\n").map((c) => c.trim()).filter(Boolean) },
      });
      setView(saved);
      setDraft(saved.checks);
      setCommands(saved.checks.commands.join("\n"));
      setStatus("Saved to roles.toml.");
    } catch (err) {
      setError(String(err));
    }
  }

  const unchecked = commands.trim() === "" && !draft.reviewer;

  return (
    <section className="checks-panel" aria-label="Checks and limits">
      <h3>Checks before merge</h3>
      <p className="muted">
        Every proposed change is checked before it reaches you, merged with your branch as it is now.
        {unchecked && " With nothing set, changes are reported as unchecked and never land by themselves."}
      </p>

      <label htmlFor="checks-commands">Commands, one per line</label>
      <textarea
        id="checks-commands"
        className="mono"
        rows={3}
        value={commands}
        onChange={(event) => {
          setCommands(event.target.value);
          setStatus(null);
        }}
        placeholder={"npm test\ncargo test"}
        spellCheck={false}
      />

      <div className="checks-row">
        <label>
          Reviewer
          <select
            value={draft.reviewer ?? ""}
            onChange={(event) => update({ reviewer: event.target.value || null })}
          >
            <option value="">None</option>
            {view.roles.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>
        <label title="A second look, only when the first reviewer calls the change medium or high risk">
          Second opinion
          <select
            value={draft.escalate_to ?? ""}
            onChange={(event) => update({ escalate_to: event.target.value || null })}
          >
            <option value="">None</option>
            {view.roles.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>
        <label>
          Time per command (s)
          <input
            type="number"
            min={1}
            value={draft.timeout_secs}
            onChange={(event) => update({ timeout_secs: Math.max(1, Number(event.target.value) || 1) })}
          />
        </label>
      </div>

      <h3>Limits</h3>
      <div className="checks-row">
        <label title="More than this wait their turn as queued. Takes effect the next time the project opens.">
          Workers at once
          <input
            type="number"
            min={1}
            max={32}
            value={draft.max_parallel_workers}
            onChange={(event) => update({ max_parallel_workers: Math.max(1, Number(event.target.value) || 1) })}
          />
        </label>
        <label title="A worker running longer is stopped; what it wrote stays on its branch">
          Minutes per worker
          <input
            type="number"
            min={1}
            value={draft.worker_timeout_mins}
            onChange={(event) => update({ worker_timeout_mins: Math.max(1, Number(event.target.value) || 1) })}
          />
        </label>
        <label title="Fresh tokens (not cache reads) this project may spend in any five hours before new workers are refused. Blank for no limit.">
          Tokens per 5 hours
          <input
            type="number"
            min={1}
            step={100000}
            placeholder="No limit"
            value={draft.budget_tokens_5h ?? ""}
            onChange={(event) => {
              const value = Number(event.target.value);
              update({ budget_tokens_5h: event.target.value === "" || !value ? null : Math.max(1, value) });
            }}
          />
        </label>
      </div>

      <div className="checks-actions">
        <button className="primary" onClick={() => void save()}>
          Save
        </button>
        {status && <span className="muted">{status}</span>}
        {error && <span className="error">{error}</span>}
      </div>
    </section>
  );
}
