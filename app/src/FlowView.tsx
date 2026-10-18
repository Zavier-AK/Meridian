import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Flow, Plan, Worker } from "./types";

type Props = {
  workers: Worker[];
  flows: Flow[];
  headBusy: boolean;
  headModel: string | null;
  plan: Plan | null;
  onSelectWorker: (id: string) => void;
};

type Box = { id: string; x: number; y: number; w: number; h: number };
type EdgeState = "live" | "done" | "failed" | "waiting" | "review" | "landed" | "pr" | "muted" | "chat" | "feeds";
type Edge = { key: string; from: string; to: string; state: EdgeState; label?: string; title?: string };

const LIVE = new Set(["queued", "blocked", "preparing", "running"]);
const PULSE_MS = 3500;
const NODE_W = 156;
const WORKER_H = 66;
const HUB_H = 48;
const MAX_WORKERS = 12;

/** Where each box sits: you, then the head agent, then the workers in rows, then where work lands. */
function layout(width: number, workers: Worker[], hasPr: boolean) {
  const boxes = new Map<string, Box>();
  const cx = width / 2;
  const put = (id: string, x: number, y: number, w: number, h: number) =>
    boxes.set(id, { id, x: x - w / 2, y, w, h });
  put("you", cx, 18, 120, HUB_H - 8);
  put("head", cx, 110, 200, HUB_H + 8);
  const perRow = Math.max(1, Math.min(5, Math.floor((width - 32) / (NODE_W + 18))));
  const rows = Math.max(1, Math.ceil(workers.length / perRow));
  const rowY = (row: number) => 236 + row * (WORKER_H + 46);
  workers.forEach((worker, i) => {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, workers.length - row * perRow);
    const span = inRow * NODE_W + (inRow - 1) * 18;
    const left = cx - span / 2;
    const col = i % perRow;
    boxes.set(worker.id, { id: worker.id, x: left + col * (NODE_W + 18), y: rowY(row), w: NODE_W, h: WORKER_H });
  });
  const bottom = rowY(rows - 1) + WORKER_H + 74;
  if (hasPr) {
    put("branch", cx - 110, bottom, 170, HUB_H);
    put("github", cx + 110, bottom, 170, HUB_H);
  } else {
    put("branch", cx, bottom, 190, HUB_H);
  }
  return { boxes, height: bottom + HUB_H + 24 };
}

/** A smooth vertical curve from the bottom of one box to the top of another. */
function curve(a: Box, b: Box, offset = 0): string {
  const down = a.y < b.y;
  const x1 = a.x + a.w / 2 + offset;
  const y1 = down ? a.y + a.h : a.y;
  const x2 = b.x + b.w / 2 + offset;
  const y2 = down ? b.y : b.y + b.h;
  const mid = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
}

/** Between two workers: an arc under them, so it doesn't cross the boxes. */
function arc(a: Box, b: Box): string {
  const x1 = a.x + a.w / 2;
  const x2 = b.x + b.w / 2;
  const y1 = a.y + a.h;
  const y2 = b.y + b.h;
  const dip = Math.max(y1, y2) + 26 + Math.min(30, Math.abs(x2 - x1) / 8);
  return `M ${x1} ${y1} C ${x1} ${dip}, ${x2} ${dip}, ${x2} ${y2}`;
}

function workerEdgeState(worker: Worker): EdgeState {
  if (LIVE.has(worker.status)) return "live";
  if (worker.status === "awaiting_approval") return "waiting";
  if (worker.status === "failed") return "failed";
  if (worker.status === "cancelled") return "muted";
  return "done";
}

const STATUS_WORD: Record<Worker["status"], string> = {
  queued: "queued",
  blocked: "waiting for lock",
  preparing: "preparing",
  awaiting_approval: "needs your OK",
  running: "working",
  done: "done",
  failed: "failed",
  cancelled: "stopped",
};

const KIND_LABEL: Record<Flow["kind"], string> = {
  message: "message",
  reply: "reply",
  task: "task",
  result: "result",
  review: "for review",
  checks: "checks",
  landed: "landed",
  undone: "undone",
  revision: "sent back",
  pr: "pull request",
  ask: "asks you",
};

function clip(text: string, length: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}

/**
 * Who is working on what, and what is moving between them: you and the head agent, the
 * head agent and each worker, and each worker's change on its way to your branch or a
 * pull request. Edges light up as things move; the log underneath says what moved.
 */
export default function FlowView({ workers, flows, headBusy, headModel, plan, onSelectWorker }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [now, setNow] = useState(() => Date.now());

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(360, entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Recent movements pulse for a few seconds; tick while any do.
  const latest = flows[0]?.at ?? 0;
  useEffect(() => {
    setNow(Date.now());
    if (Date.now() - latest > PULSE_MS) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - latest > PULSE_MS) clearInterval(timer);
    }, 500);
    return () => clearInterval(timer);
  }, [latest]);

  // Newest first, but live ones always make the cut.
  const shown = useMemo(() => {
    const sorted = [...workers].sort((a, b) => a.startedAt - b.startedAt);
    if (sorted.length <= MAX_WORKERS) return sorted;
    const live = sorted.filter((w) => LIVE.has(w.status) || w.status === "awaiting_approval");
    const rest = sorted.filter((w) => !live.includes(w)).slice(-(MAX_WORKERS - live.length));
    return [...rest, ...live].sort((a, b) => a.startedAt - b.startedAt);
  }, [workers]);
  const hidden = workers.length - shown.length;
  const hasPr = shown.some((w) => w.pullRequest);
  const { boxes, height } = layout(width, shown, hasPr);

  const edges: Edge[] = [];
  const messages = flows.filter((f) => f.kind === "message").length;
  edges.push({
    key: "you-head",
    from: "you",
    to: "head",
    state: headBusy ? "live" : "chat",
    label: messages ? `${messages} message${messages === 1 ? "" : "s"}` : undefined,
  });
  for (const worker of shown) {
    edges.push({
      key: `head-${worker.id}`,
      from: "head",
      to: worker.id,
      state: workerEdgeState(worker),
      title: worker.task ? `Task: ${worker.task}` : undefined,
    });
    if (worker.landed) {
      edges.push({ key: `${worker.id}-branch`, from: worker.id, to: "branch", state: "landed" });
    } else if (worker.branch && worker.diff && worker.diff.files_changed > 0 && !LIVE.has(worker.status)) {
      edges.push({ key: `${worker.id}-branch`, from: worker.id, to: "branch", state: "review" });
    }
    if (worker.pullRequest) {
      edges.push({ key: `${worker.id}-github`, from: worker.id, to: "github", state: "pr" });
    }
  }
  // A plan's steps that feed later ones.
  const stepWorker = new Map((plan?.steps ?? []).filter((s) => s.worker_id).map((s) => [s.id, s.worker_id!]));
  for (const step of plan?.steps ?? []) {
    if (!step.worker_id) continue;
    for (const dep of step.depends_on) {
      const from = stepWorker.get(dep);
      if (from && boxes.has(from) && boxes.has(step.worker_id)) {
        edges.push({ key: `${from}-feeds-${step.worker_id}`, from, to: step.worker_id, state: "feeds", title: "feeds into" });
      }
    }
  }

  const pathFor = (edge: Edge): string | null => {
    const a = boxes.get(edge.from);
    const b = boxes.get(edge.to);
    if (!a || !b) return null;
    return edge.state === "feeds" ? arc(a, b) : curve(a, b);
  };

  // A dot travels each edge something just moved along, in the direction it moved.
  const pulses = flows
    .filter((flow) => now - flow.at < PULSE_MS)
    .map((flow) => {
      const forward = edges.find((e) => e.from === flow.from && e.to === flow.to);
      const backward = edges.find((e) => e.from === flow.to && e.to === flow.from);
      const edge = forward ?? backward;
      const d = edge && pathFor(edge);
      return d ? { key: `${flow.at}-${flow.from}-${flow.to}`, d, reverse: !forward, kind: flow.kind } : null;
    })
    .filter(Boolean) as { key: string; d: string; reverse: boolean; kind: Flow["kind"] }[];

  const box = (id: string) => boxes.get(id)!;
  const you = box("you");
  const head = box("head");
  const branch = box("branch");
  const github = boxes.get("github");
  const landedCount = shown.filter((w) => w.landed).length;
  const reviewCount = edges.filter((e) => e.state === "review").length;

  return (
    <section className="flow-view">
      <div className="flow-legend">
        <span className="flow-key live">working</span>
        <span className="flow-key done">finished</span>
        <span className="flow-key review">waiting for review</span>
        <span className="flow-key landed">landed</span>
        <span className="flow-key failed">failed</span>
        {hidden > 0 && <span className="muted">+{hidden} earlier not shown</span>}
      </div>
      <div className="flow-canvas" ref={wrapRef}>
        <svg width={width} height={height} role="img" aria-label="How work and information move between the agents">
          <defs>
            {/* One arrowhead per edge state: older WebKit has no context-stroke. */}
            {(["live", "done", "failed", "waiting", "review", "landed", "pr", "muted", "chat", "feeds"] as EdgeState[]).map((state) => (
              <marker
                key={state}
                id={`flow-arrow-${state}`}
                className={`flow-arrow ${state}`}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            ))}
          </defs>

          {edges.map((edge) => {
            const d = pathFor(edge);
            if (!d) return null;
            return (
              <g key={edge.key} className={`flow-edge ${edge.state}`}>
                {edge.title && <title>{edge.title}</title>}
                <path d={d} className="flow-edge-hit" />
                <path d={d} className="flow-edge-line" markerEnd={`url(#flow-arrow-${edge.state})`} />
              </g>
            );
          })}

          {/* You ⇄ head label, beside the line. */}
          {edges[0].label && (
            <text x={you.x + you.w / 2 + 12} y={(you.y + you.h + head.y) / 2 + 4} className="flow-edge-label">
              {edges[0].label}
            </text>
          )}

          {pulses.map((pulse) => (
            <circle key={pulse.key} r="4.5" className={`flow-pulse ${pulse.kind}`}>
              <animateMotion
                dur="1.1s"
                repeatCount="3"
                path={pulse.d}
                keyPoints={pulse.reverse ? "1;0" : "0;1"}
                keyTimes="0;1"
                calcMode="linear"
              />
            </circle>
          ))}

          <g className="flow-node hub you">
            <rect x={you.x} y={you.y} width={you.w} height={you.h} rx={you.h / 2} />
            <text x={you.x + you.w / 2} y={you.y + you.h / 2 + 5} className="flow-node-title" textAnchor="middle">
              You
            </text>
          </g>

          <g className={`flow-node hub head ${headBusy ? "busy" : ""}`}>
            <rect x={head.x} y={head.y} width={head.w} height={head.h} rx={14} />
            <text x={head.x + head.w / 2} y={head.y + 23} className="flow-node-title" textAnchor="middle">
              Head agent
            </text>
            <text x={head.x + head.w / 2} y={head.y + 41} className="flow-node-sub" textAnchor="middle">
              {headBusy ? "thinking…" : "plans and delegates"}
              {headModel ? ` · ${headModel}` : ""}
            </text>
          </g>

          {shown.map((worker) => {
            const b = box(worker.id);
            const state = workerEdgeState(worker);
            const lines = worker.diff ? `+${worker.diff.insertions} −${worker.diff.deletions}` : "";
            return (
              <g
                key={worker.id}
                className={`flow-node worker ${state}`}
                onClick={() => onSelectWorker(worker.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && onSelectWorker(worker.id)}
              >
                <title>{worker.task ? `${worker.role}: ${worker.task}` : worker.role}</title>
                <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={12} />
                <circle cx={b.x + 14} cy={b.y + 18} r={4} className="flow-dot" />
                <text x={b.x + 24} y={b.y + 22} className="flow-node-title">
                  {clip(`${worker.number ? `#${worker.number} ` : ""}${worker.role}`, 17)}
                </text>
                <text x={b.x + 12} y={b.y + 40} className="flow-node-sub">
                  {clip(worker.task ? worker.task : STATUS_WORD[worker.status], 24)}
                </text>
                <text x={b.x + 12} y={b.y + 56} className="flow-node-meta">
                  {STATUS_WORD[worker.status]}
                  {worker.revision ? ` · rev ${worker.revision}` : ""}
                </text>
                {lines && (
                  <text x={b.x + b.w - 10} y={b.y + 56} className="flow-node-meta lines" textAnchor="end">
                    {lines}
                  </text>
                )}
              </g>
            );
          })}

          {shown.length === 0 && (
            <text x={width / 2} y={276} className="flow-node-sub" textAnchor="middle">
              No workers yet — ask the head agent for something and they'll appear here.
            </text>
          )}

          <g className="flow-node hub branch">
            <rect x={branch.x} y={branch.y} width={branch.w} height={branch.h} rx={12} />
            <text x={branch.x + branch.w / 2} y={branch.y + 21} className="flow-node-title" textAnchor="middle">
              Your branch
            </text>
            <text x={branch.x + branch.w / 2} y={branch.y + 38} className="flow-node-sub" textAnchor="middle">
              {landedCount} landed · {reviewCount} waiting
            </text>
          </g>
          {github && (
            <g className="flow-node hub github">
              <rect x={github.x} y={github.y} width={github.w} height={github.h} rx={12} />
              <text x={github.x + github.w / 2} y={github.y + 21} className="flow-node-title" textAnchor="middle">
                GitHub
              </text>
              <text x={github.x + github.w / 2} y={github.y + 38} className="flow-node-sub" textAnchor="middle">
                {shown.filter((w) => w.pullRequest).length} pull request(s)
              </text>
            </g>
          )}
        </svg>
      </div>

      <div className="flow-log">
        <h3>What moved</h3>
        {flows.length === 0 ? (
          <p className="muted">Messages, tasks, results and merges show up here as they happen.</p>
        ) : (
          <ol>
            {flows.slice(0, 80).map((flow) => (
              <li
                key={`${flow.at}-${flow.from}-${flow.to}-${flow.kind}`}
                className={`flow-log-row ${flow.kind} ${flow.workerId ? "clickable" : ""} ${now - flow.at < PULSE_MS ? "fresh" : ""}`}
                onClick={() => flow.workerId && onSelectWorker(flow.workerId)}
              >
                <span className="flow-log-time mono">
                  {new Date(flow.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })}
                </span>
                <span className="flow-log-route">
                  {flow.fromLabel} <span className="muted">→</span> {flow.toLabel}
                </span>
                <span className={`flow-log-kind ${flow.kind}`}>{KIND_LABEL[flow.kind]}</span>
                {flow.text && <span className="flow-log-text">{clip(flow.text, 140)}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
