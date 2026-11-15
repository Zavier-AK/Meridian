import { useEffect, useRef, useState } from "react";

export type NeedsYouItem = {
  key: string;
  /** What is waiting, in a few words. */
  label: string;
  /** Which kind, for the icon and the order: asks first, then reviews, then the rest. */
  kind: "ask" | "approve" | "review" | "plan" | "night";
  open: () => void;
};

const ORDER: Record<NeedsYouItem["kind"], number> = { ask: 0, approve: 1, review: 2, plan: 3, night: 4 };
const KIND_LABEL: Record<NeedsYouItem["kind"], string> = {
  ask: "Asking",
  approve: "To approve",
  review: "To review",
  plan: "Plan",
  night: "Night shift",
};

/**
 * Everything waiting on the person in one place: the head agent asking to do something,
 * delegations to approve, changes to review, a plan to run, a night shift's report.
 * Each used to be a dot or a card somewhere different; this lists them all and goes to
 * each one. Hidden when nothing is waiting.
 */
export default function NeedsYou({ items }: { items: NeedsYouItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  useEffect(() => {
    if (items.length === 0) setOpen(false);
  }, [items.length]);

  if (items.length === 0) return null;
  const sorted = [...items].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);

  return (
    <div className="needs-you" ref={ref}>
      <button
        className="needs-you-button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Everything waiting on you"
      >
        Needs you <span className="needs-you-count mono">{items.length}</span>
      </button>
      {open && (
        <ul className="needs-you-list" role="menu">
          {sorted.map((item) => (
            <li key={item.key} role="none">
              <button
                role="menuitem"
                className={`needs-you-item ${item.kind}`}
                onClick={() => {
                  setOpen(false);
                  item.open();
                }}
              >
                <span className="needs-you-kind">{KIND_LABEL[item.kind]}</span>
                <span className="needs-you-label">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
