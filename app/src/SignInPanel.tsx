import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClaudeAccount } from "./types";

type Props = {
  /** What the failed run said, when this opened because of one. */
  problem: string | null;
  /** Shown in a modal over the session, or inline in Settings. */
  inline?: boolean;
  onClose?: () => void;
  /** Called after the head agent was reconnected. */
  onReconnected?: () => void;
};

const METHOD: Record<string, string> = {
  oauth_token: "Claude subscription",
  api_key: "API key (Console billing)",
  none: "not signed in",
};

/**
 * Help with Claude's sign-in, as Meridian sees it: which `claude` it runs, whether that one
 * is signed in, and the two fixes — reconnect the head agent (a long-running process can
 * hold a token another Claude process has since refreshed), or sign in again.
 */
export default function SignInPanel({ problem, inline, onClose, onReconnected }: Props) {
  const [account, setAccount] = useState<ClaudeAccount | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<"reconnect" | "signin" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setChecking(true);
    try {
      setAccount(await invoke<ClaudeAccount>("claude_account"));
    } catch (err) {
      setError(String(err));
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    void check();
  }, []);

  async function reconnect() {
    setBusy("reconnect");
    setError(null);
    setNote(null);
    try {
      await invoke("reconnect_head");
      setNote("Reconnected. The head agent carries on the same conversation with a fresh sign-in.");
      onReconnected?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function signIn() {
    setBusy("signin");
    setError(null);
    setNote(null);
    try {
      await invoke("claude_sign_in");
      setNote("Terminal opened on `claude auth login`. Finish signing in there, then press Check again and Reconnect.");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  const body = (
    <div className={`signin ${inline ? "inline" : ""}`}>
      {!inline && (
        <header className="signin-head">
          <div>
            <h2>Claude sign-in</h2>
            <p className="muted">As Meridian sees it — which can differ from your terminal.</p>
          </div>
          {onClose && (
            <button className="ghost" onClick={onClose} aria-label="Close">
              ✕
            </button>
          )}
        </header>
      )}

      {problem && (
        <div className="signin-problem">
          <strong>A Claude run couldn't sign in.</strong>
          <span className="mono">{problem}</span>
        </div>
      )}

      <dl className="signin-facts">
        <dt>Status</dt>
        <dd>
          {!account ? (
            <span className="muted">Checking…</span>
          ) : account.logged_in ? (
            <span className="signin-ok">Signed in · {METHOD[account.method ?? ""] ?? account.method}</span>
          ) : (
            <span className="signin-bad">Not signed in</span>
          )}
        </dd>
        <dt>Claude CLI</dt>
        <dd className="mono">{account?.path ?? (account ? "not found" : "…")}</dd>
        {account?.version && (
          <>
            <dt>Version</dt>
            <dd className="mono">{account.version}</dd>
          </>
        )}
      </dl>
      {account?.problem && <p className="error">{account.problem}</p>}

      <div className="signin-why muted">
        {account?.logged_in ? (
          <p>
            Signed in, but a run still failed? The head agent is one long-running Claude process, and a sign-in
            token it holds can be refreshed by another Claude process in the meantime (your terminal, or a worker).{" "}
            <strong>Reconnect</strong> restarts it with the current sign-in and keeps the conversation.
          </p>
        ) : (
          <p>
            Sign in with <strong>the same</strong> Claude CLI shown above — if your terminal finds a different one,
            signing in there doesn't help Meridian.
          </p>
        )}
      </div>

      <div className="actions">
        <button className="ghost" onClick={() => void check()} disabled={checking}>
          {checking ? "Checking…" : "Check again"}
        </button>
        <button onClick={() => void signIn()} disabled={busy !== null}>
          {busy === "signin" ? "Opening Terminal…" : "Sign in again"}
        </button>
        <button className="primary" onClick={() => void reconnect()} disabled={busy !== null}>
          {busy === "reconnect" ? "Reconnecting…" : "Reconnect head agent"}
        </button>
      </div>
      {note && <p className="signin-note">{note}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );

  if (inline) return body;
  return (
    <div className="drawer-scrim signin-scrim" onClick={onClose}>
      <div className="signin-modal" onClick={(e) => e.stopPropagation()}>
        {body}
      </div>
    </div>
  );
}
