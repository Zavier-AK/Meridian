import type { ProjectView } from "./types";
import { BranchIcon } from "./GitHubView";

export type AppView = "session" | "github" | "tools" | "settings";

type Props = {
  projects: ProjectView[];
  onFocus: (projectRoot: string) => void;
  onClose: (projectRoot: string) => void;
  onAdd: () => void;
  view: AppView;
  onView: (view: AppView) => void;
  /** Labels beside the icons, or icons alone. */
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Something on GitHub worth a look: commits not pushed yet. */
  githubDot: boolean;
};

/** Two letters for a project: the first of each of its first two words. */
export function monogram(name: string): string {
  const words = name.split(/[-_ .]+/).filter(Boolean);
  const letters =
    words.length >= 2 ? words[0][0] + words[1][0] : (words[0] ?? name).slice(0, 2);
  return letters.toUpperCase();
}

/** A stable hue per project name, so a tile keeps its colour between launches. */
function hue(name: string): number {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

function projectState(project: ProjectView): string {
  const parts = [
    project.running_workers > 0
      ? `${project.running_workers} running`
      : project.live
        ? "idle"
        : "suspended",
  ];
  if (project.pending_merges > 0) parts.push(`${project.pending_merges} to review`);
  return parts.join(" · ");
}

/**
 * The navigation rail: projects as tiles at the top, the app's other places at the
 * bottom. Narrow by default, so the session gets the width; it widens to show names.
 *
 * Every project shows its own running and to-review counts, not just the one in
 * front: forgetting a session is still going somewhere else is the easiest way to lose
 * work in a tool like this.
 */
export default function ProjectRail({
  projects,
  onFocus,
  onClose,
  onAdd,
  view,
  onView,
  expanded,
  onToggleExpanded,
  githubDot,
}: Props) {
  const place = (target: AppView) => () => onView(view === target ? "session" : target);

  return (
    <aside className={`nav-rail ${expanded ? "expanded" : ""}`} aria-label="Projects and places">
      <ul className="rail-projects">
        {projects.map((project, index) => (
          <li key={project.project_root}>
            <button
              className={`rail-item rail-project ${project.active ? "active" : ""} ${project.live ? "" : "suspended"}`}
              onClick={() => {
                onView("session");
                onFocus(project.project_root);
              }}
              title={`${project.name} — ${projectState(project)}\n${project.project_root}${index < 9 ? `\n⌘${index + 1}` : ""}`}
              aria-label={`${project.name}, ${projectState(project)}`}
              aria-current={project.active ? "page" : undefined}
            >
              <span className="monogram" style={{ "--hue": hue(project.name) } as React.CSSProperties}>
                {monogram(project.name)}
                {project.running_workers > 0 && <span className="rail-running" aria-hidden />}
                {project.pending_merges > 0 && (
                  <span className="rail-badge" aria-hidden>
                    {project.pending_merges}
                  </span>
                )}
              </span>
              <span className="rail-label">
                <span className="rail-name">{project.name}</span>
                <span className="rail-meta">{projectState(project)}</span>
              </span>
            </button>
            <button
              className="rail-close"
              onClick={() => onClose(project.project_root)}
              aria-label={`Close ${project.name}`}
              title="Close this project"
            >
              ×
            </button>
          </li>
        ))}
        <li>
          <button className="rail-item rail-add" onClick={onAdd} title="Open a project (⌘N)" aria-label="Open a project">
            <span className="rail-icon">
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </span>
            <span className="rail-label">
              <span className="rail-name">Open a project</span>
            </span>
          </button>
        </li>
      </ul>

      <nav className="rail-places" aria-label="App">
        <button
          className={`rail-item ${view === "github" ? "active" : ""}`}
          onClick={place("github")}
          aria-pressed={view === "github"}
          title="Repositories, branches and pull requests"
        >
          <span className="rail-icon">
            <BranchIcon size={15} />
            {githubDot && <span className="rail-dot" aria-label="commits not pushed" />}
          </span>
          <span className="rail-label">
            <span className="rail-name">GitHub</span>
          </span>
        </button>
        <button
          className={`rail-item ${view === "tools" ? "active" : ""}`}
          onClick={place("tools")}
          aria-pressed={view === "tools"}
          title="Tools & Skills"
        >
          <span className="rail-icon">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path
                d="M10.5 2.2a3.3 3.3 0 0 0-3.9 4.3L2.4 10.7a1.3 1.3 0 0 0 1.9 1.9l4.2-4.2a3.3 3.3 0 0 0 4.3-3.9l-2 2-1.8-.3-.3-1.8z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="rail-label">
            <span className="rail-name">Tools & Skills</span>
          </span>
        </button>
        <button
          className={`rail-item ${view === "settings" ? "active" : ""}`}
          onClick={place("settings")}
          aria-pressed={view === "settings"}
          title="Settings (⌘,)"
        >
          <span className="rail-icon">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <circle cx="6" cy="4" r="1.6" fill="var(--panel-strong)" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="10.5" cy="8" r="1.6" fill="var(--panel-strong)" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="5" cy="12" r="1.6" fill="var(--panel-strong)" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </span>
          <span className="rail-label">
            <span className="rail-name">Settings</span>
          </span>
        </button>
        <button
          className="rail-item nav-toggle"
          onClick={onToggleExpanded}
          aria-pressed={expanded}
          title={expanded ? "Narrow the sidebar (⌘\\)" : "Show names (⌘\\)"}
          aria-label={expanded ? "Narrow the sidebar" : "Show names"}
        >
          <span className="rail-icon">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <rect x="2.5" y="3" width="11" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <path d="M6.5 3v10" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </span>
          <span className="rail-label">
            <span className="rail-name">Narrow</span>
          </span>
        </button>
      </nav>
    </aside>
  );
}
