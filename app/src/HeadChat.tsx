import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatItem, PermissionDecision } from "./types";
import { compactTokens } from "./types";
import { MeridianMark } from "./Brand";
import { MAX_IMAGES, imageFiles, prepareImage, type ChatImage } from "./images";
import AgentShot from "./AgentShot";

type Props = {
  items: ChatItem[];
  busy: boolean;
  onSend: (text: string, images: ChatImage[]) => void;
  /** Who an agent run is, for its images: "Head agent", "builder". */
  labelFor?: (runId: string) => string;
  onStop: () => void;
  onSelectWorker: (id: string) => void;
  onUndo: (workerId: string) => void;
  /** Open a note an agent saved. */
  onOpenNote?: (path: string) => void;
  /** Words said for the head agent: added to the box to edit and send, never sent. */
  dictated?: { text: string; at: number } | null;
  /** Changes when voice says "send it": the draft is handed to `onDraftForVoice`. */
  sendDraft?: number;
  onDraftForVoice?: (draft: string | null) => void;
  /** The person's answer to something the head agent asked to do. */
  onPermission: (requestId: string, decision: PermissionDecision) => void;
  /** The repository has no commits yet, so workers can't start. */
  needsFirstCommit?: boolean;
  onFirstCommit?: () => void;
  /** Controls along the bottom of the chat box, left of the send button. */
  tools?: React.ReactNode;
  /** The head agent's model, shown in the chat box. */
  model?: string | null;
  /** Tokens the head agent's first request carried, shown beside its model. */
  promptTokens?: number | null;
  /** The hold-to-talk button, beside Send. */
  mic?: React.ReactNode;
};

/** Tool calls into the harness read as delegation, not as plumbing. */
function toolLabel(name: string): string {
  const stripped = name.replace(/^mcp__harness__/, "");
  switch (stripped) {
    case "delegate":
      return "Delegating to a worker";
    case "delegate_async":
      return "Fanning out a worker";
    case "check_workers":
      return "Checking on workers";
    case "collect":
      return "Collecting a result";
    case "list_roles":
      return "Reading the fleet";
    case "request_merge":
      return "Proposing a merge";
    default:
      return stripped;
  }
}

export default function HeadChat({
  items,
  busy,
  onSend,
  labelFor,
  onStop,
  onSelectWorker,
  onUndo,
  onOpenNote,
  dictated,
  sendDraft,
  onDraftForVoice,
  onPermission,
  needsFirstCommit,
  onFirstCommit,
  tools,
  model,
  promptTokens,
  mic,
}: Props) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ChatImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [enlarged, setEnlarged] = useState<string | null>(null);

  useEffect(() => {
    if (!enlarged) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setEnlarged(null);
      }
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [enlarged]);

  /** Screenshots pasted, dropped or chosen: prepared, then shown above the text. */
  async function addImages(files: File[]) {
    if (files.length === 0) return;
    setImageError(null);
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      setImageError(`At most ${MAX_IMAGES} images per message.`);
      return;
    }
    const prepared: ChatImage[] = [];
    for (const file of files.slice(0, room)) {
      try {
        prepared.push(await prepareImage(file, file.name || "Pasted image"));
      } catch (err) {
        setImageError(String(err instanceof Error ? err.message : err));
      }
    }
    if (files.length > room) setImageError(`At most ${MAX_IMAGES} images per message.`);
    setImages((prev) => [...prev, ...prepared].slice(0, MAX_IMAGES));
    inputRef.current?.focus();
  }

  // What was said lands after anything already typed, ready to edit.
  useEffect(() => {
    if (!dictated?.text) return;
    setDraft((prev) => (prev.trim() ? `${prev.trimEnd()} ${dictated.text}` : dictated.text));
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }, [dictated?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Send it": hand the draft over to be sent, and clear the box.
  useEffect(() => {
    if (!sendDraft) return;
    const text = draft.trim();
    onDraftForVoice?.(text || null);
    if (text) setDraft("");
  }, [sendDraft]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  function submit() {
    const text = draft.trim();
    if ((!text && images.length === 0) || busy) return;
    onSend(text, images);
    setDraft("");
    setImages([]);
    setImageError(null);
  }

  return (
    <section className="chat">
      <div className="transcript">
        {items.map((item, i) => {
          switch (item.kind) {
            case "user":
              return (
                <div key={i} className="bubble user">
                  {item.images && item.images.length > 0 && (
                    <div className="bubble-images">
                      {item.images.map((src, n) => (
                        <img key={n} src={src} alt={`Attached image ${n + 1}`} onClick={() => setEnlarged(src)} />
                      ))}
                    </div>
                  )}
                  {!item.images?.length && item.attached ? (
                    <span className="bubble-attached">
                      {item.attached} image{item.attached === 1 ? "" : "s"} attached
                    </span>
                  ) : null}
                  {item.text}
                </div>
              );
            case "shots":
              return (
                <div key={i} className="shots">
                  <span className="shots-label">
                    {labelFor?.(item.runId) ?? "An agent"} · {item.paths.length} image
                    {item.paths.length === 1 ? "" : "s"}
                  </span>
                  <div className="shots-strip">
                    {item.paths.map((path) => (
                      <AgentShot key={path} path={path} onOpen={setEnlarged} />
                    ))}
                  </div>
                </div>
              );
            case "assistant":
              // Rendered as markdown: the head agent writes plans, lists and code, and
              // as plain text those arrive as a wall of asterisks and backticks. Raw HTML
              // stays off — model output is never trusted as markup.
              return (
                <div key={i} className="bubble assistant markdown">
                  <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
                </div>
              );
            case "tool":
              return (
                <button
                  key={i}
                  className="tool-chip"
                  onClick={() => item.workerId && onSelectWorker(item.workerId)}
                  disabled={!item.workerId}
                >
                  {toolLabel(item.name)}
                </button>
              );
            case "notice":
              return (
                <div key={i} className={`notice ${item.tone}`}>
                  {item.text}
                </div>
              );
            case "note":
              return (
                <div key={i} className="notice info note-saved">
                  <span>
                    {item.created ? "Started a note" : "Updated a note"}: <span className="mono">{item.path}</span>
                  </span>
                  {onOpenNote && (
                    <button className="link" onClick={() => onOpenNote(item.path)}>
                      Open
                    </button>
                  )}
                </div>
              );
            case "output":
              return (
                <details key={i} className={`notice plugin-output ${item.ok ? "info" : "error"}`}>
                  <summary>{item.title}</summary>
                  <pre className="mono">{item.text || "(no output)"}</pre>
                </details>
              );
            case "permission":
              return <PermissionCard key={i} item={item} onAnswer={onPermission} />;
            case "landed":
              // The way back sits right next to the news, so letting changes land by
              // themselves never means losing control of them.
              return (
                <div key={i} className={`notice landed ${item.undone ? "undone" : ""}`}>
                  <span>{item.undone ? `${item.text} Undone.` : item.text}</span>
                  {!item.undone && (
                    <button className="link" onClick={() => onUndo(item.workerId)}>
                      Undo
                    </button>
                  )}
                </div>
              );
          }
        })}
        {busy && (
          <div className="bubble assistant thinking">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
          </div>
        )}
        {!items.some((item) => item.kind === "user" || item.kind === "assistant") && (
          <div className="chat-welcome">
            <MeridianMark size={56} />
            <span>Ready when you are.</span>
            <span className="muted">Describe what you want built. The head agent plans it and hands it to the fleet.</span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {enlarged && (
        <div className="shot-lightbox" role="dialog" aria-label="Image, full size" onClick={() => setEnlarged(null)}>
          <img src={enlarged} alt="Full size" onClick={(e) => e.stopPropagation()} />
          <button className="shot-lightbox-close" onClick={() => setEnlarged(null)} aria-label="Close (Esc)">
            ×
          </button>
        </div>
      )}

      {needsFirstCommit && (
        <div className="first-commit">
          <span>
            This repository has no commits yet, so workers have nothing to branch from.
          </span>
          <button onClick={onFirstCommit} title="Adds a .gitignore if there is none, then commits everything else">
            Make the first commit
          </button>
        </div>
      )}

      <div
        className={`composer ${dropping ? "dropping" : ""}`}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes("Files")) {
            e.preventDefault();
            setDropping(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
        }}
        onDrop={(e) => {
          const files = imageFiles(e.dataTransfer.files);
          setDropping(false);
          if (files.length > 0) {
            e.preventDefault();
            void addImages(files);
          }
        }}
      >
        {images.length > 0 && (
          <div className="composer-images">
            {images.map((image, n) => (
              <span key={n} className="composer-image" title={image.name}>
                <img src={image.preview} alt={image.name} />
                <button
                  className="composer-image-remove"
                  onClick={() => setImages((prev) => prev.filter((_, m) => m !== n))}
                  aria-label={`Remove ${image.name}`}
                  title="Remove"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {imageError && <p className="composer-image-error">{imageError}</p>}
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData.items);
            if (files.length > 0) {
              e.preventDefault();
              void addImages(files);
            }
          }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline; Escape stops a running turn.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape" && busy) {
              e.preventDefault();
              onStop();
            }
          }}
          placeholder={busy ? "Working… (Esc to stop)" : "What should we build?"}
          rows={2}
        />
        <div className="composer-bar">
          <div className="composer-tools">
            <button
              className="composer-pill composer-attach"
              onClick={() => fileRef.current?.click()}
              title="Add images (or paste or drop them here)"
              aria-label="Add images"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              hidden
              onChange={(e) => {
                void addImages(imageFiles(e.target.files));
                e.target.value = "";
              }}
            />
            {tools}
          </div>
          {model && (
            <span
              className="composer-model"
              title={`The head agent's model (change the default in Settings)${
                promptTokens
                  ? `\nEach turn starts from a ${promptTokens.toLocaleString()}-token prompt — instructions and tool definitions, read back from cache`
                  : ""
              }`}
            >
              {model}
              {promptTokens ? <span className="composer-prompt mono"> · {compactTokens(promptTokens)}</span> : null}
            </span>
          )}
          {mic}
          {busy ? (
            // While the head agent works, the send button is the way out. Stopping keeps
            // the conversation: the next message carries on from here.
            <button className="send stop" onClick={onStop} title="Stop this turn (Esc)" aria-label="Stop">
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                <rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button className="send" onClick={submit} disabled={!draft.trim() && images.length === 0} title="Send (Enter)" aria-label="Send">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/** Something the head agent wants to do that it isn't approved for: a command, a file
 * change. It waits, mid-turn, for the person. */
function PermissionCard({
  item,
  onAnswer,
}: {
  item: Extract<ChatItem, { kind: "permission" }>;
  onAnswer: (requestId: string, decision: PermissionDecision) => void;
}) {
  const settled = item.state === "allowed" || item.state === "denied" || item.state === "lapsed";
  return (
    <div className={`permission ${item.state}`}>
      <div className="permission-head">
        <span className="permission-tool">{item.tool}</span>
        <span className="permission-what">{item.description}</span>
      </div>
      {item.detail && <pre className="permission-detail">{item.detail}</pre>}
      {settled ? (
        <div className="permission-outcome">
          {item.state === "allowed" ? "Allowed" : item.state === "denied" ? "Denied" : "No longer asked"}
        </div>
      ) : (
        <div className="permission-actions">
          <button
            className="primary"
            disabled={item.state === "sending"}
            onClick={() => onAnswer(item.requestId, "allow")}
          >
            Allow
          </button>
          {item.rules.length > 0 && (
            <button
              disabled={item.state === "sending"}
              onClick={() => onAnswer(item.requestId, "always")}
              title={`Always allow in this project: ${item.rules.join(", ")}`}
            >
              Always allow
            </button>
          )}
          <button
            className="deny"
            disabled={item.state === "sending"}
            onClick={() => onAnswer(item.requestId, "deny")}
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
