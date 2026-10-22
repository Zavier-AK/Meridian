import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BranchInfo, PullRequestSummary, PullRequestsView, RepoSummary, Worker } from "./types";

type Props = {
  repos: RepoSummary[];
  /** Which repository to show first; the project's own when empty. */
  initialRepo: string;
  workers: Record<string, Worker>;
  onRefresh: () => void;
  onSelectWorker: (id: string) => void;
  /** Hand a pull request to the head agent to review. */
  onReview: (repo: RepoSummary, pr: PullRequestSummary) => void;
  onClose: () => void;
};

/** A branch: two commits and the line between them. */
export function BranchIcon({ size = 12 }: { size?: number }) {
  return (
    <svg className="branch-icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4.5" cy="12.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11.5" cy="5.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.5 5.1v5.8M11.5 7.1c0 2.6-3.2 2.4-6.2 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function ago(unixSeconds: number): string {
  if (!unixSeconds) return "";
  const seconds = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (seconds < 90) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 36) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 60) return `${Math.round(days)}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

function githubUrl(repo: RepoSummary, suffix = ""): string | null {
  const gh = repo.remote?.github;
  return gh ? `https://github.com/${gh.owner}/${gh.repo}${suffix}` : null;
}

/** Where a checkout stands against its upstream, in words. */
export function tracking(repo: { upstream: string | null; ahead: number; behind: number }): string {
  if (!repo.upstream) return "not pushed yet";
  if (!repo.ahead && !repo.behind) return `up to date with ${repo.upstream}`;
  const parts = [];
  if (repo.ahead) parts.push(`${repo.ahead} to push`);
  if (repo.behind) parts.push(`${repo.behind} to pull`);
  return `${parts.join(", ")} · ${repo.upstream}`;
}

const REVIEW_LABEL: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  REVIEW_REQUIRED: "review required",
};

/**
 * Every repository the project spans, with its branches and open pull requests, in one
 * place. Branch changes are small and reversible by design: switching refuses
 * uncommitted work, deleting refuses anything unmerged, and the project's own branch
 * can't move while workers are running from it.
 */
export default function GitHubView({
  repos,
  initialRepo,
  workers,
  onRefresh,
  onSelectWorker,
  onReview,
  onClose,
}: Props) {
  const [selectedPath, setSelectedPath] = useState(initialRepo);
  const repo = repos.find((r) => r.path === selectedPath) ?? repos[0] ?? null;
  const [tab, setTab] = useState<"branches" | "prs">("branches");
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [prs, setPrs] = useState<PullRequestsView | null>(null);
  const [prError, setPrError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState("");

  const path = repo?.path ?? null;

  const loadBranches = useCallback(() => {
    if (path === null) return;
    invoke<BranchInfo[]>("github_branches", { repo: path })
      .then(setBranches)
      .catch((err) => setNotice({ ok: false, text: String(err) }));
  }, [path]);

  const loadPrs = useCallback(() => {
    if (path === null) return;
    setPrError(null);
    invoke<PullRequestsView>("github_pull_requests", { repo: path })
      .then(setPrs)
      .catch((err) => setPrError(String(err)));
  }, [path]);

  useEffect(() => {
    setBranches(null);
    setPrs(null);
    setNotice(null);
    loadBranches();
    loadPrs();
  }, [loadBranches, loadPrs]);

  async function act(kind: string, name?: string, number?: number) {
    if (path === null) return;
    setBusy(`${kind}:${name ?? number ?? ""}`);
    setNotice(null);
    try {
      const done = await invoke<string>("github_branch_action", { repo: path, kind, name, number });
      setNotice({ ok: true, text: done });
      if (kind === "create") setNewBranch("");
      loadBranches();
      if (kind === "push" || kind === "checkout_pr") loadPrs();
      onRefresh();
    } catch (err) {
      setNotice({ ok: false, text: String(err) });
    } finally {
      setBusy(null);
    }
  }

  // Pull requests whose branch is checked out here, or that this session opened.
  const openedBy = useMemo(
    () => new Map((prs?.opened ?? []).map((o) => [o.url, o.worker_id] as const)),
    [prs],
  );
  const localBranches = useMemo(() => new Set((branches ?? []).map((b) => b.name)), [branches]);

  const workerLabel = (id: string) => {
    const worker = workers[id];
    return worker ? `${worker.number ? `#${worker.number} ` : ""}${worker.role}` : id;
  };

  if (!repo) {
    return (
      <section className="github-view">
        <header className="settings-head">
          <h2>GitHub</h2>
          <button className="ghost" onClick={onClose}>
            Done
          </button>
        </header>
        <p className="muted">This project isn't a git repository, and has none inside it.</p>
      </section>
    );
  }

  const web = githubUrl(repo);
  const canPush = Boolean(repo.remote) && Boolean(repo.branch) && repo.has_commits && (!repo.upstream || repo.ahead > 0);

  return (
    <section className="github-view" aria-label="GitHub">
      <header className="settings-head">
        <h2>GitHub</h2>
        <span className="github-head-actions">
          <button
            className="ghost"
            onClick={() => {
              onRefresh();
              loadBranches();
              loadPrs();
            }}
            title="Read the repositories again"
          >
            Refresh
          </button>
          <button className="ghost" onClick={onClose} title="Back to the session (Esc)">
            Done
          </button>
        </span>
      </header>

      {repos.length > 1 && (
        <div className="repo-picker" role="tablist" aria-label="Repositories in this project">
          {repos.map((r) => (
            <button
              key={r.path}
              role="tab"
              aria-selected={r.path === repo.path}
              className={`repo-pick ${r.path === repo.path ? "active" : ""}`}
              onClick={() => setSelectedPath(r.path)}
              title={r.path || "the project folder"}
            >
              <span className="repo-pick-name">{r.name}</span>
              <span className="repo-pick-meta mono">
                {r.branch ?? "detached"}
                {r.ahead > 0 && ` ↑${r.ahead}`}
                {r.behind > 0 && ` ↓${r.behind}`}
                {r.changed > 0 && ` · ${r.changed} changed`}
              </span>
              {r.kind !== "project" && (
                <span className="repo-kind">{r.kind === "submodule" ? "submodule" : "nested repo"} · {r.path}</span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="repo-card">
        <div className="repo-card-main">
          <span className="repo-title">
            {repo.name}
            {repo.kind !== "project" && <span className="muted mono repo-path"> {repo.path}</span>}
          </span>
          <span className="repo-facts">
            <span className="mono repo-branch">
              <BranchIcon /> {repo.branch ?? "detached HEAD"}
            </span>
            <span className="muted">{repo.has_commits ? tracking(repo) : "no commits yet"}</span>
            {repo.changed > 0 && <span className="repo-changed">{repo.changed} uncommitted</span>}
          </span>
          <span className="muted mono repo-remote">{repo.remote ? `${repo.remote.name} · ${repo.remote.url}` : "no remote"}</span>
        </div>
        <div className="repo-card-actions">
          {canPush && repo.branch && (
            <button className="primary" disabled={busy !== null} onClick={() => void act("push", repo.branch!)}>
              {repo.upstream ? `Push ${repo.ahead}` : "Publish branch"}
            </button>
          )}
          {web && (
            <button onClick={() => void invoke("open_link", { url: web })}>Open on GitHub</button>
          )}
        </div>
      </div>

      {notice && <p className={`github-notice ${notice.ok ? "ok" : "error"}`}>{notice.text}</p>}

      <nav className="rail-tabs github-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "branches"} className={tab === "branches" ? "active" : ""} onClick={() => setTab("branches")}>
          Branches{branches ? ` ${branches.length}` : ""}
        </button>
        <button role="tab" aria-selected={tab === "prs"} className={tab === "prs" ? "active" : ""} onClick={() => setTab("prs")}>
          Pull requests{prs && prs.gh === "ready" ? ` ${prs.items.length}` : ""}
        </button>
      </nav>

      {tab === "branches" && (
        <div className="github-list">
          <form
            className="inline-form new-branch"
            onSubmit={(event) => {
              event.preventDefault();
              if (newBranch.trim()) void act("create", newBranch.trim());
            }}
          >
            <input
              className="grow mono"
              value={newBranch}
              onChange={(event) => setNewBranch(event.target.value)}
              placeholder={`New branch from ${repo.branch ?? "here"}`}
              aria-label="New branch name"
              spellCheck={false}
            />
            <button type="submit" disabled={!newBranch.trim() || busy !== null}>
              Create and switch
            </button>
          </form>
          {branches === null && <p className="muted">Reading branches…</p>}
          <ul className="github-rows">
            {(branches ?? []).map((branch) => (
              <li key={branch.name} className={`github-row ${branch.current ? "current" : ""}`}>
                <div className="github-row-main">
                  <span className="mono github-row-title">
                    {branch.current && <span className="current-mark" title="checked out">●</span>}
                    {branch.name}
                  </span>
                  <span className="github-row-meta muted">
                    {branch.subject && <span className="github-subject">{branch.subject}</span>}
                    <span>{ago(branch.updated)}</span>
                    <span>
                      {branch.gone
                        ? "deleted on the remote"
                        : branch.upstream
                          ? tracking(branch)
                          : "local only"}
                    </span>
                    {branch.merged && <span className="pill ok">merged</span>}
                    {branch.worker && (
                      <button className="pill link-pill" onClick={() => onSelectWorker(branch.worker!)}>
                        {workerLabel(branch.worker)}
                      </button>
                    )}
                  </span>
                </div>
                <div className="github-row-actions">
                  {!branch.current && (
                    <button disabled={busy !== null} onClick={() => void act("switch", branch.name)}>
                      Switch
                    </button>
                  )}
                  {repo.remote && !branch.worker && (!branch.upstream || branch.ahead > 0) && !branch.gone && (
                    <button disabled={busy !== null} onClick={() => void act("push", branch.name)}>
                      Push
                    </button>
                  )}
                  {branch.merged && (
                    <button className="ghost danger" disabled={busy !== null} onClick={() => void act("delete", branch.name)} title="It's already part of the current branch">
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === "prs" && (
        <div className="github-list">
          {prError && <p className="error">{prError}</p>}
          {!prs && !prError && <p className="muted">Asking GitHub…</p>}
          {prs?.gh === "missing" && (
            <p className="muted">
              Pull requests are read with the GitHub CLI. Install it (<code>brew install gh</code>), then
              run <code>gh auth login</code>.
            </p>
          )}
          {prs?.gh === "signed_out" && (
            <p className="muted">
              The GitHub CLI isn't signed in. Run <code>gh auth login</code> in a terminal, then Refresh.
            </p>
          )}
          {prs?.gh === "ready" && prs.items.length === 0 && (
            <p className="muted">No open pull requests{repo.remote?.github ? ` on ${repo.name}` : ""}.</p>
          )}
          <ul className="github-rows">
            {(prs?.items ?? []).map((pr) => {
              const worker = openedBy.get(pr.url);
              const checks = pr.checks;
              return (
                <li key={pr.number} className="github-row">
                  <div className="github-row-main">
                    <span className="github-row-title">
                      <span className="muted mono">#{pr.number}</span> {pr.title}
                    </span>
                    <span className="github-row-meta muted">
                      <span className="mono">
                        {pr.head} → {pr.base}
                      </span>
                      <span>{pr.author}</span>
                      {pr.draft && <span className="pill">draft</span>}
                      {pr.review && <span className={`pill ${pr.review === "APPROVED" ? "ok" : pr.review === "CHANGES_REQUESTED" ? "bad" : ""}`}>{REVIEW_LABEL[pr.review] ?? pr.review.toLowerCase()}</span>}
                      {checks.failed > 0 && (
                        <span className="pill bad" title={checks.failing.join(", ")}>
                          {checks.failed} failing
                        </span>
                      )}
                      {checks.failed === 0 && checks.pending > 0 && <span className="pill">{checks.pending} running</span>}
                      {checks.failed === 0 && checks.pending === 0 && checks.passed > 0 && <span className="pill ok">checks pass</span>}
                      {localBranches.has(pr.head) && <span className="pill">branch here</span>}
                      {worker && (
                        <button className="pill link-pill" onClick={() => onSelectWorker(worker)}>
                          from {workerLabel(worker)}
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="github-row-actions">
                    <button onClick={() => onReview(repo, pr)} title="Ask the head agent to have it reviewed">
                      Review with agent
                    </button>
                    <button disabled={busy !== null} onClick={() => void act("checkout_pr", undefined, pr.number)}>
                      Check out
                    </button>
                    <button className="ghost" onClick={() => void invoke("open_link", { url: pr.url })}>
                      Open
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
