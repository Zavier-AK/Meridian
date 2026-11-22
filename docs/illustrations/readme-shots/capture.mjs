// The README's screenshots: the real UI, driven by a stand-in for the Tauri backend.
//
//   cd app && npm run build && npx vite preview --port 5199 --strictPort &
//   node docs/illustrations/readme-shots/capture.mjs docs/screenshots
//
// Every command the UI calls is answered from the fixtures below, so a shot shows a
// believable session without running any agents. PLAYWRIGHT can point at a Playwright
// install if `playwright` isn't resolvable from here.
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");

const out = process.argv[2] ?? "docs/screenshots";
const URL = process.env.MERIDIAN_URL ?? "http://localhost:5199/";

const THEMES = {
  graphite: { base: "#111214", accent: "#e4e6eb", accent_2: "#8b93a7" },
  ember: { base: "#0c0c0e", accent: "#ff7a1a", accent_2: "#ffc43d" },
};

// ---------------------------------------------------------------- fixtures

const ROOT = "/Users/you/calendar";
const roles = [
  ["architect", "claude", "opus", "readonly", false],
  ["builder", "claude", "sonnet", "worktree", true],
  ["tester", "codex", null, "readonly", false],
  ["local", "ollama", "qwen3-coder", "worktree", true],
].map(([name, provider, model, isolation, can_edit_files]) => ({
  name, provider, model, isolation, can_edit_files, brief: null, available: true, unavailable_reason: null,
}));
const backends = [
  { id: "claude", label: "Claude CLI", available: true, message: "", base_url: null,
    models: ["sonnet", "opus", "haiku"].map((id) => ({ id, capability: "chat" })) },
  { id: "codex", label: "Codex CLI", available: true, message: "", base_url: null, models: [] },
  { id: "ollama", label: "Ollama", available: true, message: "", base_url: "http://localhost:11434",
    models: [{ id: "qwen3-coder", capability: "chat" }] },
];
const session = { session_id: "s1", project_root: ROOT, mcp_url: "x", resumed_head_session: true, home: false, roles, backends };
const usage = (i, o) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: 0, cache_read_input_tokens: i * 6 });

const PATCH = `diff --git a/src/views/Week.tsx b/src/views/Week.tsx
--- a/src/views/Week.tsx
+++ b/src/views/Week.tsx
@@ -1,9 +1,11 @@
 import { useState } from "react";
+import { useKeys } from "../keys";
 import { Day } from "./Day";

 export function Week({ start, events }: Props) {
   const [focus, setFocus] = useState(0);
+  useKeys({ ArrowLeft: () => setFocus((d) => Math.max(0, d - 1)), ArrowRight: () => setFocus((d) => Math.min(6, d + 1)), t: () => setFocus(today(start)) });
   return (
     <div className="week" role="grid">
       {days(start).map((day, i) => (
-        <Day key={day.iso} day={day} events={events[day.iso]} />
+        <Day key={day.iso} day={day} events={events[day.iso]} focused={i === focus} />
       ))}
diff --git a/src/keys.ts b/src/keys.ts
new file mode 100644
--- /dev/null
+++ b/src/keys.ts
@@ -0,0 +1,14 @@
+import { useEffect } from "react";
+
+/** Key handlers for a view, ignored while typing in a field. */
+export function useKeys(handlers: Record<string, () => void>) {
+  useEffect(() => {
+    const onKey = (event: KeyboardEvent) => {
+      if ((event.target as HTMLElement).closest("input, textarea")) return;
+      handlers[event.key]?.();
+    };
+    window.addEventListener("keydown", onKey);
+    return () => window.removeEventListener("keydown", onKey);
+  }, [handlers]);
+}
`;
const review = {
  risk: "low", verified: true,
  reasons: ["npm test passed (48 tests)", "the reviewer found nothing blocking"],
  checks: [
    { kind: "signals", name: "signals", status: "passed", summary: "2 files, +27 −1, tests touched" },
    { kind: "command", name: "npm test", status: "passed", summary: "48 passed" },
    { kind: "review", name: "review", status: "passed", summary: "Small and focused; keys are ignored while typing.", risk: "low", reviewer: "architect",
      findings: [{ severity: "low", file: "src/keys.ts", line: 9, message: "handlers changes every render; the listener is re-added each time" }] },
  ],
};
const workerEvents = [
  { type: "worker_spawned", worker_id: "w-1", role: "builder", provider: "claude", model: "sonnet", isolation: "worktree", cwd: "", number: 1, task: "Add keyboard shortcuts to the week view" },
  { type: "worker_finished", worker_id: "w-1", summary: "Arrow keys move between days and t jumps to today; ignored while typing. Added src/keys.ts.", usage: usage(18200, 2400), diff: { files_changed: 2, insertions: 27, deletions: 1, files: ["src/views/Week.tsx", "src/keys.ts"] }, is_error: false },
  { type: "worker_status_changed", worker_id: "w-1", status: "done" },
  { type: "merge_requested", worker_id: "w-1", branch: "harness/w-1", diff: { files_changed: 2, insertions: 27, deletions: 1, files: ["src/views/Week.tsx", "src/keys.ts"] } },
  { type: "verification_finished", worker_id: "w-1", report: review },
  { type: "worker_spawned", worker_id: "w-2", role: "tester", provider: "codex", model: null, isolation: "readonly", cwd: "", number: 2, task: "Cover the date parser with tests" },
  { type: "worker_status_changed", worker_id: "w-2", status: "running" },
  { type: "worker_spawned", worker_id: "w-3", role: "local", provider: "ollama", model: "qwen3-coder", isolation: "worktree", cwd: "", number: 3, task: "Make the settings page work on a phone" },
  { type: "worker_status_changed", worker_id: "w-3", status: "running" },
  { type: "worker_spawned", worker_id: "w-0", role: "builder", provider: "claude", model: "sonnet", isolation: "worktree", cwd: "", number: 4, task: "Fix the timezone shift on all-day events" },
  { type: "worker_finished", worker_id: "w-0", summary: "All-day events are stored as dates, not midnight UTC.", usage: usage(9100, 1300), diff: { files_changed: 3, insertions: 41, deletions: 12, files: ["src/date/parse.ts", "src/date/parse.test.ts", "src/store.ts"] }, is_error: false },
  { type: "worker_status_changed", worker_id: "w-0", status: "done" },
  { type: "merge_landed", worker_id: "w-0", branch: "harness/w-0", commit: "4be91c2", automatic: true, risk: "low" },
];
const chatHistory = [
  { type: "user_message", run_id: "o", text: "The calendar needs to be ready for the beta. Add keyboard shortcuts to the week view, cover the date parser with tests, and make settings usable on a phone." },
  { type: "assistant_text", run_id: "o", partial: false, text: "Three independent pieces, so they can run at once:\n\n- **builder** takes the keyboard shortcuts (arrow keys between days, `t` for today)\n- **tester** covers the date parser, including the all-day timezone case we fixed yesterday\n- **local** takes the settings layout, since it's mostly CSS\n\nEach gets its own worktree; I'll bring you anything that needs a decision." },
  { type: "tool_call", run_id: "o", tool_use_id: "t1", name: "mcp__harness__delegate", input: {} },
  { type: "tool_call", run_id: "o", tool_use_id: "t2", name: "mcp__harness__delegate", input: {} },
  { type: "tool_call", run_id: "o", tool_use_id: "t3", name: "mcp__harness__delegate", input: {} },
  { type: "head_notice", run_id: "o", text: "builder #1 finished: Arrow keys move between days and t jumps to today. Its change is checked: low risk." },
  { type: "assistant_text", run_id: "o", partial: false, text: "The shortcuts are done and checked: tests pass and the architect called it low risk, with one small note about re-adding the listener on each render. It's waiting for your review. The tester and the settings work are still running." },
];
const changes = [
  { worker_id: "w-3", role: "local", state: "working", files: [
    { path: "src/settings/Page.tsx", insertions: 18, deletions: 9, binary: false, added: false },
    { path: "src/settings/page.css", insertions: 34, deletions: 6, binary: false, added: false } ] },
  { worker_id: "w-1", role: "builder", state: "review", files: [
    { path: "src/views/Week.tsx", insertions: 4, deletions: 1, binary: false, added: false },
    { path: "src/keys.ts", insertions: 23, deletions: 0, binary: false, added: true } ] },
  { worker_id: "w-0", role: "builder", state: "landed", files: [
    { path: "src/date/parse.ts", insertions: 12, deletions: 8, binary: false, added: false },
    { path: "src/date/parse.test.ts", insertions: 26, deletions: 0, binary: false, added: true },
    { path: "src/store.ts", insertions: 3, deletions: 4, binary: false, added: false } ] },
  { worker_id: null, role: null, state: "uncommitted", files: [
    { path: "README.md", insertions: 6, deletions: 2, binary: false, added: false } ] },
];
const remote = { name: "origin", url: "git@github.com:you/calendar.git", github: { owner: "you", repo: "calendar" } };
const repos = [
  { path: "", name: "calendar", kind: "project", branch: "main", upstream: "origin/main", ahead: 1, behind: 0, changed: 1, has_commits: true, remote },
  { path: "packages/ui", name: "ui", kind: "submodule", branch: "main", upstream: "origin/main", ahead: 0, behind: 2, changed: 0, has_commits: true,
    remote: { name: "origin", url: "git@github.com:you/calendar-ui.git", github: { owner: "you", repo: "calendar-ui" } } },
];
const now = Math.floor(Date.now() / 1000);
const branches = [
  { name: "main", current: true, upstream: "origin/main", ahead: 1, behind: 0, gone: false, updated: now - 600 },
  { name: "harness/w-1", current: false, upstream: null, ahead: 1, behind: 0, gone: false, updated: now - 900 },
  { name: "harness/w-3", current: false, upstream: null, ahead: 2, behind: 0, gone: false, updated: now - 300 },
  { name: "beta-polish", current: false, upstream: "origin/beta-polish", ahead: 0, behind: 0, gone: false, updated: now - 86400 },
  { name: "old-month-view", current: false, upstream: "origin/old-month-view", ahead: 0, behind: 0, gone: true, updated: now - 86400 * 12 },
];
const prStatus = (state, passed, failed = 0, pending = 0) => ({ state, draft: false, passed, failed, pending });
const pulls = {
  gh: "ready",
  items: [
    { number: 42, title: "Keyboard shortcuts for the week view", url: "https://github.com/you/calendar/pull/42", head: "harness/w-1", base: "main", author: "you", draft: false, review: "REVIEW_REQUIRED", checks: prStatus("pending", 3, 0, 1), updated_at: new Date(Date.now() - 600e3).toISOString() },
    { number: 39, title: "Store all-day events as dates", url: "https://github.com/you/calendar/pull/39", head: "beta-polish", base: "main", author: "you", draft: false, review: "APPROVED", checks: prStatus("success", 4), updated_at: new Date(Date.now() - 86400e3).toISOString() },
  ],
  opened: [{ worker_id: "w-1", url: "https://github.com/you/calendar/pull/42" }],
};

// ---------------------------------------------------------------- the stand-in backend

function stub({ session, settings, chatHistory, workerEvents, changes, repos, branches, pulls, patch, review }) {
  window.__handlers = {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  const answers = {
    open_home: session, start_session: session,
    list_projects: [
      { project_root: "/Users/you/Documents/Meridian Home", name: "Home", active: false, live: false, running_workers: 0, pending_merges: 0, home: true },
      { project_root: session.project_root, name: "calendar", active: true, live: true, running_workers: 2, pending_merges: 1, home: false },
    ],
    get_settings: settings, get_autonomy: "review", night_status: null,
    voice_status: { built: false, settings: { enabled: false }, listening: false, pending: null },
    inspect_project: { exists: true, is_git_repo: true, has_commits: true, has_roles_file: true },
    chat_history: chatHistory, worker_snapshot: workerEvents, changes_overview: changes,
    github_overview: { repos }, github_branches: branches, github_pull_requests: pulls,
    worker_patch: { text: patch, truncated: false, total_lines: patch.split("\n").length },
    worker_verification: { state: "done", report: review },
    session_roles: session.roles,
    usage: [{ provider: "claude", input_tokens: 41000, output_tokens: 6200, cache_creation_tokens: 8000, cache_read_tokens: 265112, cost_usd: 0, runs: 9 }],
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" } },
    invoke: async (cmd, args) => {
      if (cmd === "plugin:event|listen") { (window.__handlers[args.event] ||= []).push(args.handler); return args.handler; }
      if (cmd.startsWith("plugin:")) return null;
      if (cmd in answers) return answers[cmd];
      if (["plugins_list", "list_skills", "list_plans", "probe_preview_servers", "quotas"].includes(cmd)) return [];
      return null;
    },
    transformCallback: (cb) => { const id = Math.floor(Math.random() * 1e9); window[`_${id}`] = cb; return id; },
  };
}

// ---------------------------------------------------------------- shots

const browser = await chromium.launch();

async function open(theme, background, viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.log("page error:", e.message));
  const settings = {
    default_model: null, max_turns: 200, notifications: true, font: "grotesk",
    voice: { enabled: false }, openrouter_models: [], notes: { enabled: true, folder: null }, home_folder: null,
    ...THEMES[theme],
    background: { style: "liquid", intensity: 0.6, speed: 1, grain: 12, accent: null, accent_2: null, ...background },
  };
  await page.addInitScript(stub, { session, settings, chatHistory, workerEvents, changes, repos, branches, pulls, patch: PATCH, review });
  // In the app the window sits on the desktop's vibrancy; here it needs a floor.
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "html { background: var(--base); }";
      document.head.appendChild(style);
    });
  });
  await page.goto(URL);
  await page.waitForTimeout(1500);
  // The project, not Home, in front.
  await page.getByText("calendar", { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(800);
  return page;
}
async function showRail(page) {
  const show = page.getByRole("button", { name: "Show workers" });
  if (await show.count()) await show.click();
  await page.waitForTimeout(300);
}
async function shot(page, name, clip) {
  // The marker a restored chat ends with says nothing in a still.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll(".notice")) if (el.textContent === "Earlier conversation above.") el.remove();
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}.png`, ...(clip ? { clip } : {}) });
  console.log("wrote", name);
}

{ // Hero: the chat, black and white, liquid behind.
  const page = await open("graphite", { style: "liquid", intensity: 0.7 });
  await showRail(page);
  await shot(page, "home");
  await page.close();
}
{ // The chat on its own, leaves framing it.
  const page = await open("graphite", { style: "leaves", intensity: 0.55 });
  await shot(page, "chat");
  await page.close();
}
{ // Changes panel.
  const page = await open("graphite", { style: "tide", intensity: 0.5 });
  await showRail(page);
  await page.getByRole("tab", { name: "Changes" }).click();
  await shot(page, "changes");
  await page.close();
}
{ // Flow, in Ember.
  const page = await open("ember", { style: "current", intensity: 0.45 });
  await page.getByRole("tab", { name: "Flow" }).click().catch(async () => page.getByText("Flow", { exact: true }).click());
  await shot(page, "flow");
  await page.close();
}
{ // Review, in Ember.
  const page = await open("ember", { style: "ripple", intensity: 0.5 });
  await showRail(page);
  await page.locator(".worker-card").first().click();
  await shot(page, "review");
  await page.close();
}
{ // GitHub, black and white.
  const page = await open("graphite", { style: "liquid", intensity: 0.45 });
  await page.locator(".repo-chip").first().click();
  await page.waitForTimeout(600);
  await shot(page, "github");
  await page.close();
}
{ // The autonomy slider in the chat bar, Ember.
  const page = await open("ember", { style: "sakura", intensity: 0.6 }, { width: 1100, height: 760 });
  await page.locator(".autonomy-pill").click();
  await page.waitForTimeout(300);
  const bar = await page.locator(".composer").first().boundingBox();
  const pop = await page.locator(".autonomy-pop").boundingBox();
  const top = Math.min(bar.y, pop?.y ?? bar.y) - 20;
  await shot(page, "slider", { x: bar.x - 20, y: top, width: Math.min(bar.width, 640) + 40, height: bar.y + bar.height + 20 - top });
  await page.close();
}
// The backgrounds themselves, three to a row.
for (const [style, theme] of [["liquid", "graphite"], ["leaves", "graphite"], ["sakura", "ember"]]) {
  const page = await open(theme, { style, intensity: 0.7 }, { width: 1200, height: 760 });
  await shot(page, `background-${style}`);
  await page.close();
}

await browser.close();
