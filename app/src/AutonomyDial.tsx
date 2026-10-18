import { useEffect, useRef, useState } from "react";
import type { Autonomy } from "./types";

/** The four stops, most supervised first. Mirrors `Autonomy` in the engine. */
export const STOPS: { level: Autonomy; label: string; description: string }[] = [
  {
    level: "ask",
    label: "Ask",
    description: "Every delegation waits for your approval, and every merge.",
  },
  {
    level: "review",
    label: "Review",
    description: "Delegations run freely; every merge waits for you.",
  },
  {
    level: "land_safe",
    label: "Land safe",
    description:
      "Delegations run freely. Changes that were verified and are low risk land by themselves — with Undo. The rest wait for you.",
  },
  {
    level: "land_most",
    label: "Land most",
    description:
      "Delegations run freely. Verified changes land by themselves unless they are high risk — with Undo. High risk and unverified wait for you.",
  },
];

type Props = {
  level: Autonomy;
  onChange: (level: Autonomy) => void;
};

/** What each stop lets through, as a picture: a raised hand, an eye, a shield, a bolt. */
function StopIcon({ level }: { level: Autonomy }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (level) {
    case "ask":
      return (
        <svg {...common}>
          <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L3 16a1.6 1.6 0 0 1 2.4-2.1L8 16" />
        </svg>
      );
    case "review":
      return (
        <svg {...common}>
          <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "land_safe":
      return (
        <svg {...common}>
          <path d="M12 3 4 6v6c0 4.4 3.4 8.2 8 9 4.6-.8 8-4.6 8-9V6l-8-3Z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case "land_most":
      return (
        <svg {...common}>
          <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
        </svg>
      );
  }
}

/**
 * How much runs without you — Karpathy's autonomy slider, as an actual slider.
 *
 * A pill in the chat bar names the current stop; it opens a slider with the four stops.
 * Drag the knob, click a stop, or use the arrow keys. The engine enforces the level; this
 * only chooses it.
 */
export default function AutonomyDial({ level, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const index = Math.max(0, STOPS.findIndex((stop) => stop.level === level));
  const shown = dragging ?? index;
  const current = STOPS[Math.round(shown)] ?? STOPS[1];

  // Outside click or Escape closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /** Where along the track a pointer is, in stops (0 to 3, fractional while dragging). */
  function stopAt(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return index;
    const inset = 22; // the knob's radius plus padding: stops sit inside the ends
    const span = rect.width - inset * 2;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left - inset) / span));
    return ratio * (STOPS.length - 1);
  }

  function settle(at: number) {
    const chosen = STOPS[Math.round(at)].level;
    setDragging(null);
    if (chosen !== level) onChange(chosen);
  }

  const percent = (shown / (STOPS.length - 1)) * 100;

  return (
    <div className="autonomy" ref={rootRef}>
      <button
        className={`autonomy-pill level-${level}`}
        onClick={() => setOpen((was) => !was)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${STOPS[index]?.label} — ${STOPS[index]?.description} (⌘⇧A cycles)`}
      >
        <StopIcon level={level} />
        <span>{STOPS[index]?.label}</span>
      </button>
      {open && (
        <div className="autonomy-pop" role="dialog" aria-label="How much runs without you">
          <div className="autonomy-pop-head">
            <div>
              <div className={`autonomy-pop-title level-${current.level}`}>{current.label}</div>
              <div className="autonomy-pop-sub">How much runs without you</div>
            </div>
            <button
              className="autonomy-reset"
              onClick={() => onChange("review")}
              title="Back to Review, the default"
              aria-label="Reset to Review"
              disabled={level === "review"}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4" />
              </svg>
            </button>
          </div>
          <div
            ref={trackRef}
            className={`autonomy-track ${dragging !== null ? "dragging" : ""}`}
            role="slider"
            tabIndex={0}
            aria-valuemin={0}
            aria-valuemax={STOPS.length - 1}
            aria-valuenow={index}
            aria-valuetext={current.label}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowUp") {
                e.preventDefault();
                settle(Math.min(STOPS.length - 1, index + 1));
              } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
                e.preventDefault();
                settle(Math.max(0, index - 1));
              }
            }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              setDragging(stopAt(e.clientX));
            }}
            onPointerMove={(e) => {
              if (dragging !== null) setDragging(stopAt(e.clientX));
            }}
            onPointerUp={(e) => {
              if (dragging !== null) settle(stopAt(e.clientX));
            }}
            onPointerCancel={() => setDragging(null)}
          >
            <div className={`autonomy-fill level-${current.level}`} style={{ width: `calc(22px + (100% - 44px) * ${percent / 100} + 18px)` }} />
            {STOPS.map((stop, i) => (
              <span
                key={stop.level}
                className={`autonomy-dot ${i <= shown ? "passed" : ""}`}
                style={{ left: `calc(22px + (100% - 44px) * ${i / (STOPS.length - 1)})` }}
              />
            ))}
            <span
              className="autonomy-knob"
              style={{ left: `calc(22px + (100% - 44px) * ${percent / 100})` }}
            />
          </div>
          <div className="autonomy-stops">
            {STOPS.map((stop) => (
              <button
                key={stop.level}
                className={stop.level === current.level ? "active" : ""}
                onClick={() => settle(STOPS.indexOf(stop))}
              >
                {stop.label}
              </button>
            ))}
          </div>
          <p className="autonomy-desc">{current.description}</p>
        </div>
      )}
    </div>
  );
}

/** The next stop round the dial, for the keyboard shortcut. */
export function nextStop(level: Autonomy): Autonomy {
  const index = Math.max(0, STOPS.findIndex((stop) => stop.level === level));
  return STOPS[(index + 1) % STOPS.length].level;
}
