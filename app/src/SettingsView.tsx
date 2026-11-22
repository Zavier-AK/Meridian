import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AppSettings, BackgroundSettings, VoiceSettings } from "./types";
import { BACKGROUND_DEFAULTS, BACKGROUND_STYLES, applyBackground } from "./asciiBackground";
import VoiceSettingsPanel from "./VoiceSettings";
import { FONTS, applyFont } from "./fonts";
import { PRESETS, THEME_DEFAULTS, applyTheme, isLightColour } from "./appSettings";
import SignInPanel from "./SignInPanel";
import OpenRouterSettings from "./OpenRouterSettings";

type Props = {
  onSaved: (settings: AppSettings) => void;
  onClose: () => void;
};

/** Aliases the Claude CLI resolves itself, so they never go stale with a model release. */
const MODELS = ["opus", "sonnet", "haiku"];

export default function SettingsView({ onSaved, onClose }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      invoke<AppSettings>("get_settings")
        .then((loaded) => {
          setSettings(loaded);
          setSaved(loaded);
        })
        .catch((err) => setError(String(err)));
    void load();
    // Changed by voice while this is open: show what's saved now.
    const off = listen<string>("harness://changed", ({ payload }) => {
      if (payload === "settings") void load();
    });
    return () => void off.then((f) => f());
  }, []);

  // A font tried but not saved goes back when Settings closes.
  const savedFont = useRef<string | null>(null);
  savedFont.current = saved?.font ?? null;
  useEffect(() => () => applyFont(savedFont.current), []);

  // Colours apply as they're picked; unsaved ones go back when Settings closes.
  const savedTheme = useRef<AppSettings | null>(null);
  savedTheme.current = saved;
  useEffect(() => {
    if (settings) applyTheme(settings);
  }, [settings?.base, settings?.accent, settings?.accent_2]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      if (savedTheme.current) applyTheme(savedTheme.current);
    },
    [],
  );
  // The background previews the same way.
  useEffect(() => {
    if (settings) applyBackground(settings.background);
  }, [settings?.background]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      if (savedTheme.current) applyBackground(savedTheme.current.background);
    },
    [],
  );

  if (!settings) {
    return (
      <section className="settings-view">
        {error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}
      </section>
    );
  }

  const dirty = JSON.stringify(settings) !== JSON.stringify(saved);

  async function save() {
    if (!settings) return;
    setError(null);
    try {
      const stored = await invoke<AppSettings>("save_settings", { settings });
      setSettings(stored);
      setSaved(stored);
      onSaved(stored);
    } catch (err) {
      setError(String(err));
    }
  }

  const update = (patch: Partial<AppSettings>) => setSettings({ ...settings, ...patch });

  return (
    <section className="settings-view" aria-label="Settings">
      <header className="settings-head">
        <h2>Settings</h2>
        <button className="ghost" onClick={onClose} title="Back to the session (Esc)">
          Done
        </button>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="settings-section">
        <h3>Head agent</h3>
        <p className="muted">
          Used when a project opens. A head agent already running keeps what it started with.
          “sonnet” and “opus” always mean the newest of each.
        </p>
        <label className="field">
          <span>Model</span>
          <input
            list="model-suggestions"
            value={settings.default_model ?? ""}
            onChange={(event) => update({ default_model: event.target.value || null })}
            placeholder="sonnet (the newest)"
            spellCheck={false}
          />
          <datalist id="model-suggestions">
            {MODELS.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>Turn limit</span>
          <input
            type="number"
            min={1}
            max={1000}
            value={settings.max_turns}
            onChange={(event) => update({ max_turns: Number(event.target.value) })}
          />
        </label>
      </div>

      <div className="settings-section">
        <h3>Notifications</h3>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={settings.notifications}
            onChange={(event) => update({ notifications: event.target.checked })}
          />
          <span>Tell me when a worker finishes or a change waits for review, while I'm away</span>
        </label>
      </div>

      <VoiceSettingsPanel
        value={settings.voice}
        onChange={(voice: VoiceSettings) => update({ voice })}
      />

      <div className="settings-section">
        <h3>Claude sign-in</h3>
        <SignInPanel problem={null} inline />
      </div>

      <div className="settings-section">
        <h3>Home</h3>
        <p className="muted">
          The folder Meridian opens at launch, for chats that aren't about one of your projects yet.
          Anything the agents build from those chats goes here, on its own git history. Takes effect
          the next time Meridian starts.
        </p>
        <div className="inline-form">
          <input
            className="grow mono"
            value={settings.home_folder ?? ""}
            onChange={(event) => update({ home_folder: event.target.value || null })}
            placeholder="~/Documents/Meridian Home"
            aria-label="Home folder"
            spellCheck={false}
          />
          <button
            onClick={async () => {
              const picked = await openDialog({ directory: true, multiple: false, title: "Choose a home folder" });
              if (typeof picked === "string") update({ home_folder: picked });
            }}
          >
            Choose…
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h3>Notes</h3>
        <p className="muted">
          What agents learn in one project, kept for the next: decisions, conventions, gotchas.
          Only your <code>me.md</code> and the current project's note are given to the head agent up
          front, cut to a short page; it searches the rest when it's relevant. Plain markdown, so
          the folder opens as an Obsidian vault too.
        </p>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={settings.notes?.enabled ?? true}
            onChange={(event) =>
              update({ notes: { enabled: event.target.checked, folder: settings.notes?.folder ?? null } })
            }
          />
          <span>Keep notes between projects</span>
        </label>
        <div className="inline-form">
          <input
            className="grow mono"
            value={settings.notes?.folder ?? ""}
            onChange={(event) =>
              update({ notes: { enabled: settings.notes?.enabled ?? true, folder: event.target.value || null } })
            }
            placeholder="~/Documents/Meridian Notes"
            aria-label="Notes folder"
            spellCheck={false}
          />
          <button
            onClick={async () => {
              const picked = await openDialog({ directory: true, multiple: false, title: "Choose a notes folder" });
              if (typeof picked === "string") {
                update({ notes: { enabled: settings.notes?.enabled ?? true, folder: picked } });
              }
            }}
          >
            Choose…
          </button>
        </div>
        <p className="muted">
          An Obsidian vault works: pick a folder inside it, such as <code>Vault/Meridian</code>, so agents
          only ever see and write their own notes.
        </p>
      </div>

      <OpenRouterSettings
        models={settings.openrouter_models ?? []}
        onChange={(openrouter_models) => update({ openrouter_models })}
      />

      <div className="settings-section">
        <h3>Typeface</h3>
        <div className="font-choices" role="radiogroup" aria-label="Typeface">
          {FONTS.map((font) => (
            <button
              key={font.id}
              role="radio"
              aria-checked={settings.font === font.id}
              className={`font-choice ${settings.font === font.id ? "chosen" : ""}`}
              onClick={() => {
                update({ font: font.id });
                applyFont(font.id);
              }}
            >
              <span className="font-sample-title" style={{ fontFamily: font.display }}>
                {font.label}
              </span>
              <span className="font-sample-body" style={{ fontFamily: font.body }}>
                The head agent plans; the workers build.
              </span>
              <span className="font-sample-mono" style={{ fontFamily: font.mono }}>
                src/fetch.ts +12 −3
              </span>
              <span className="muted font-note">{font.note}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <h3>Theme</h3>
        <p className="muted">
          Three colours: the base everything is tinted from, the accent for buttons, selection and
          links, and a second accent for pull requests, the glow behind the window and the gradients.
        </p>
        <div className="theme-presets" role="radiogroup" aria-label="Ready-made themes">
          {PRESETS.map((preset) => {
            const chosen =
              settings.base === preset.base && settings.accent === preset.accent && settings.accent_2 === preset.accent_2;
            const shown = {
              base: preset.base ?? THEME_DEFAULTS.base,
              accent: preset.accent ?? THEME_DEFAULTS.accent,
              accent_2: preset.accent_2 ?? THEME_DEFAULTS.accent_2,
            };
            return (
              <button
                key={preset.name}
                role="radio"
                aria-checked={chosen}
                className={`theme-preset ${chosen ? "chosen" : ""}`}
                style={{ background: shown.base }}
                onClick={() => update({ base: preset.base, accent: preset.accent, accent_2: preset.accent_2 })}
              >
                <span
                  className="theme-preset-mark"
                  style={{ background: `linear-gradient(135deg, ${shown.accent}, ${shown.accent_2})` }}
                />
                <span className="theme-preset-name" style={{ color: isLightColour(shown.base) ? "#141218" : "#f4f1f5" }}>
                  {preset.name}
                </span>
              </button>
            );
          })}
        </div>
        <div className="theme-colours">
          {(
            [
              ["base", "Base"],
              ["accent", "Accent"],
              ["accent_2", "Second accent"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="theme-colour">
              <input
                type="color"
                value={settings[key] ?? THEME_DEFAULTS[key]}
                onChange={(event) => update({ [key]: event.target.value } as Partial<AppSettings>)}
                aria-label={label}
              />
              <span>
                <span className="theme-colour-name">{label}</span>
                <span className="mono muted">{settings[key] ?? "theme"}</span>
              </span>
              {settings[key] && (
                <button
                  className="ghost theme-colour-reset"
                  onClick={(event) => {
                    event.preventDefault();
                    update({ [key]: null } as Partial<AppSettings>);
                  }}
                  title="Back to the theme's own"
                >
                  Reset
                </button>
              )}
            </label>
          ))}
        </div>
      </div>

      <BackgroundSection
        background={settings.background ?? BACKGROUND_DEFAULTS}
        onChange={(change) => update({ background: { ...(settings.background ?? BACKGROUND_DEFAULTS), ...change } })}
      />

      <div className="actions">
        <button
          className="ghost"
          disabled={!dirty}
          onClick={() => {
            setSettings(saved);
            applyFont(saved?.font);
          }}
        >
          Revert
        </button>
        <button className="primary" disabled={!dirty} onClick={() => void save()}>
          Save
        </button>
      </div>
    </section>
  );
}

/** The moving ASCII background: which, how strong, how fast, how fine, and its colours. */
function BackgroundSection({
  background,
  onChange,
}: {
  background: BackgroundSettings;
  onChange: (change: Partial<BackgroundSettings>) => void;
}) {
  const ownColours = background.accent !== null || background.accent_2 !== null;
  const about = BACKGROUND_STYLES.find((style) => style.id === background.style)?.about;
  const off = background.style === "off";
  return (
    <div className="settings-section">
      <h3>Background</h3>
      <p className="muted">
        A moving field of characters behind the window. It pauses while the window is hidden, and
        holds still when the system asks for reduced motion.
      </p>
      <div className="background-styles" role="radiogroup" aria-label="Background">
        {BACKGROUND_STYLES.map((style) => (
          <button
            key={style.id}
            role="radio"
            aria-checked={background.style === style.id}
            className={`background-style ${background.style === style.id ? "chosen" : ""}`}
            onClick={() => onChange({ style: style.id })}
          >
            {style.label}
          </button>
        ))}
      </div>
      {about && <p className="muted background-about">{about}</p>}
      {!off && (
        <>
          <div className="background-sliders">
            <label className="field">
              <span>Intensity</span>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={background.intensity}
                onChange={(event) => onChange({ intensity: Number(event.target.value) })}
              />
              <span className="mono muted">{Math.round(background.intensity * 100)}%</span>
            </label>
            <label className="field">
              <span>Speed</span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={background.speed}
                onChange={(event) => onChange({ speed: Number(event.target.value) })}
              />
              <span className="mono muted">{background.speed === 0 ? "still" : `${background.speed.toFixed(2)}×`}</span>
            </label>
            <label className="field">
              <span>Grain</span>
              <input
                type="range"
                min={8}
                max={18}
                step={1}
                value={background.grain}
                onChange={(event) => onChange({ grain: Number(event.target.value) })}
              />
              <span className="mono muted">{background.grain}px</span>
            </label>
          </div>
          <div className="background-colours">
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={!ownColours}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? { accent: null, accent_2: null }
                      : {
                          accent: cssColour("--accent") ?? "#ff9ebb",
                          accent_2: cssColour("--accent-2") ?? "#b69cff",
                        },
                  )
                }
              />
              <span>Use the theme's accents</span>
            </label>
            {ownColours && (
              <div className="theme-colours">
                {(
                  [
                    ["accent", "Colour"],
                    ["accent_2", "Second colour"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="theme-colour">
                    <input
                      type="color"
                      value={background[key] ?? "#ffffff"}
                      onChange={(event) => onChange({ [key]: event.target.value })}
                      aria-label={`Background ${label.toLowerCase()}`}
                    />
                    <span>
                      <span className="theme-colour-name">{label}</span>
                      <span className="mono muted">{background[key]}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** A theme colour as `#rrggbb`, for seeding the pickers; `null` if it isn't a plain hex. */
function cssColour(name: string): string | null {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(value) ? value : null;
}
