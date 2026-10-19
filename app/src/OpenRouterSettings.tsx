import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { OpenRouterCatalogModel, OpenRouterKeyInfo, OpenRouterStatus } from "./types";

type Props = {
  /** The models offered in the fleet editor (saved with the rest of Settings). */
  models: string[];
  onChange: (models: string[]) => void;
};

const SLUG = /^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:/-]+$/;

function price(model: OpenRouterCatalogModel): string {
  const { prompt_per_million: input, completion_per_million: output } = model;
  if (input === null || output === null) return "price varies";
  if (input === 0 && output === 0) return "free";
  const dollars = (n: number) => `$${n < 1 ? n.toFixed(2) : n.toFixed(n < 10 ? 2 : 0)}`;
  return `${dollars(input)} in · ${dollars(output)} out per M tokens`;
}

function spent(info: OpenRouterKeyInfo): string {
  const used = info.usage === null ? null : `$${info.usage.toFixed(2)} spent`;
  const limit = info.limit === null ? "no limit" : `limit $${info.limit.toFixed(2)}`;
  return [used, limit, info.free_tier ? "free tier" : null].filter(Boolean).join(" · ");
}

/** Settings → OpenRouter: the key, and which of its models roles can be put on. */
export default function OpenRouterSettings({ models, onChange }: Props) {
  const [status, setStatus] = useState<OpenRouterStatus | null>(null);
  const [key, setKey] = useState("");
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<OpenRouterCatalogModel[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    invoke<OpenRouterStatus>("openrouter_status").then(setStatus).catch(() => {});
  }, []);

  // The catalog is public; fetched once, when this section is first shown.
  useEffect(() => {
    invoke<OpenRouterCatalogModel[]>("openrouter_catalog")
      .then(setCatalog)
      .catch((err) => setCatalogError(String(err)));
  }, []);

  const byId = useMemo(
    () => new Map((catalog ?? []).map((model) => [model.id, model] as const)),
    [catalog],
  );

  async function verify() {
    setBusy(true);
    try {
      const info = await invoke<OpenRouterKeyInfo>("openrouter_check");
      setCheck({ ok: true, text: `Key works — ${spent(info)}` });
    } catch (err) {
      setCheck({ ok: false, text: String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function saveKey() {
    setBusy(true);
    setCheck(null);
    try {
      setStatus(await invoke<OpenRouterStatus>("openrouter_save_key", { key }));
      setKey("");
    } catch (err) {
      setCheck({ ok: false, text: String(err) });
      setBusy(false);
      return;
    }
    setBusy(false);
    void verify();
  }

  async function removeKey() {
    setCheck(null);
    try {
      setStatus(await invoke<OpenRouterStatus>("openrouter_remove_key"));
    } catch (err) {
      setCheck({ ok: false, text: String(err) });
    }
  }

  const candidate = draft.trim();
  const draftModel = byId.get(candidate);
  const draftValid = SLUG.test(candidate) && !models.includes(candidate);

  function add() {
    if (!draftValid) return;
    onChange([...models, candidate]);
    setDraft("");
  }

  return (
    <div className="settings-section openrouter">
      <h3>OpenRouter</h3>
      <p className="muted">
        Put a role on any model OpenRouter serves — Kimi, Qwen, DeepSeek, GLM, GPT, Gemini.
        Roles that work on code run Claude Code's tools on that model; text-only roles call it
        directly. This is billed per token to your OpenRouter account, not a subscription.
      </p>

      <span className={`settings-meta ${status?.source ? "ok" : ""}`}>
        {status?.source === "saved" && <>Key saved ({status.hint})</>}
        {status?.source === "environment" && (
          <>
            Using <code>OPENROUTER_API_KEY</code> from the environment ({status.hint})
          </>
        )}
        {status && !status.source && <>No key yet</>}
      </span>

      <div className="settings-actions">
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveKey();
          }}
        >
          <input
            type="password"
            className="grow"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={status?.source ? "Replace the key…" : "sk-or-v1-…"}
            aria-label="OpenRouter API key"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="primary" disabled={busy || !key.trim()}>
            Save key
          </button>
        </form>
        {status?.source && (
          <button disabled={busy} onClick={() => void verify()}>
            {busy ? "Checking…" : "Check"}
          </button>
        )}
        {status?.source === "saved" && (
          <button className="ghost" onClick={() => void removeKey()}>
            Remove
          </button>
        )}
      </div>
      {check && <span className={`settings-meta ${check.ok ? "ok" : "error"}`}>{check.text}</span>}

      <span className="settings-name">Models to offer roles</span>
      {models.length === 0 ? (
        <p className="muted">
          None yet. Add a few here, then pick them for a role in <b>Change fleet</b>.
        </p>
      ) : (
        <ul className="settings-list openrouter-models">
          {models.map((id) => {
            const info = byId.get(id);
            return (
              <li key={id}>
                <span className="openrouter-model-row">
                  <span className="mono settings-name">{id}</span>
                  <button
                    className="chip-remove"
                    aria-label={`Remove ${id}`}
                    title="Remove"
                    onClick={() => onChange(models.filter((m) => m !== id))}
                  >
                    ×
                  </button>
                </span>
                {info && (
                  <span className="muted settings-meta">
                    {info.name} · {price(info)}
                    {info.context_length ? ` · ${Math.round(info.context_length / 1000)}k context` : ""}
                    {!info.tools && " · no tool use: text-only roles only"}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          className="grow mono"
          list="openrouter-catalog"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Search models, e.g. qwen/qwen3-coder"
          aria-label="Add an OpenRouter model"
          spellCheck={false}
        />
        <datalist id="openrouter-catalog">
          {(catalog ?? []).map((model) => (
            <option key={model.id} value={model.id}>
              {model.name} — {price(model)}
              {model.tools ? "" : " — no tools"}
            </option>
          ))}
        </datalist>
        <button type="submit" disabled={!draftValid}>
          Add
        </button>
      </form>
      {candidate && draftModel && (
        <span className="muted settings-meta">
          {draftModel.name} · {price(draftModel)}
          {!draftModel.tools && " · no tool use: text-only roles only"}
        </span>
      )}
      {catalogError && (
        <span className="muted settings-meta">
          Couldn't load OpenRouter's model list ({catalogError}); you can still type a model id.
        </span>
      )}
    </div>
  );
}
