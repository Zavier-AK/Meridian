import type { AppSettings } from "./types";
import { setNotificationsEnabled } from "./notify";
import { applyFont } from "./fonts";

/** The theme's own three colours, for the pickers' starting point. */
export const THEME_DEFAULTS = { base: "#16121a", accent: "#ff9ebb", accent_2: "#b69cff" };

/** Ready-made themes: three colours each, which is all a theme is. */
export const PRESETS: { name: string; base: string | null; accent: string | null; accent_2: string | null }[] = [
  { name: "Sakura", base: null, accent: null, accent_2: null },
  { name: "Ember", base: "#0c0c0e", accent: "#ff7a1a", accent_2: "#ffc43d" },
  { name: "Tide", base: "#0a1418", accent: "#4fd1c5", accent_2: "#7c9cff" },
  { name: "Moss", base: "#0f130e", accent: "#a3e635", accent_2: "#34d399" },
  { name: "Volt", base: "#0b0a12", accent: "#8b7bff", accent_2: "#ff5fa2" },
  { name: "Graphite", base: "#111214", accent: "#e4e6eb", accent_2: "#8b93a7" },
];

/**
 * Apply settings that live in the page rather than the engine.
 *
 * A theme is three colours: the stylesheet derives every surface, border and glow from
 * them. What can't be derived in CSS is which text colour stays legible, so that is
 * chosen here: light text on a dark base, dark on a light one, and the same for what
 * rides on the accent.
 */
export function applySettings(settings: AppSettings): void {
  setNotificationsEnabled(settings.notifications);
  applyFont(settings.font);
  applyTheme(settings);
}

export function applyTheme(theme: Pick<AppSettings, "base" | "accent" | "accent_2">): void {
  const root = document.documentElement.style;
  const set = (name: string, value: string | null) =>
    value ? root.setProperty(name, value) : root.removeProperty(name);

  const { accent, accent_2 } = theme;
  let base = theme.base;
  set("--base", base);
  set("--accent", accent);
  set("--accent-2", accent_2);
  set("--on-accent", accent ? (isLight(accent) ? "#1d1418" : "#fdf6f9") : null);
  if (base || accent) {
    const light = isLight(base ?? THEME_DEFAULTS.base);
    const tint = accent ?? THEME_DEFAULTS.accent;
    base = base ?? THEME_DEFAULTS.base;
    set("--text", light ? `color-mix(in srgb, ${base} 12%, #141218)` : `color-mix(in srgb, ${tint} 6%, #f7f5f8)`);
    set("--muted", light ? `color-mix(in srgb, ${base} 45%, #141218)` : `color-mix(in srgb, ${tint} 12%, #a39ea6)`);
  } else {
    set("--text", null);
    set("--muted", null);
  }
}
export const isLightColour = (hex: string): boolean => isLight(hex);

/** Relative luminance above the midpoint — enough to choose between two text colours. */
function isLight(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b) > 0.4;
}
