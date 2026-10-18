// Typefaces bundled with the app (no network needed), and the pairings Settings offers.
// The browser only downloads a face once something on the page uses it.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/inter";
import "@fontsource-variable/manrope";

export type FontChoice = {
  id: string;
  label: string;
  /** What it feels like, for the picker. */
  note: string;
  display: string;
  body: string;
  mono: string;
};

const SYSTEM_SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
const SYSTEM_MONO = `ui-monospace, "SF Mono", Menlo, monospace`;

/** Mirrors `settings::FONTS` in the Tauri shell. The first is the default. */
export const FONTS: FontChoice[] = [
  {
    id: "grotesk",
    label: "Space Grotesk",
    note: "Characterful headings, calm DM Sans text, JetBrains Mono code",
    display: `"Space Grotesk Variable", ${SYSTEM_SANS}`,
    body: `"DM Sans Variable", ${SYSTEM_SANS}`,
    mono: `"JetBrains Mono Variable", ${SYSTEM_MONO}`,
  },
  {
    id: "geist",
    label: "Geist",
    note: "Crisp and modern, with a matching mono",
    display: `"Geist Variable", ${SYSTEM_SANS}`,
    body: `"Geist Variable", ${SYSTEM_SANS}`,
    mono: `"Geist Mono Variable", ${SYSTEM_MONO}`,
  },
  {
    id: "plex",
    label: "IBM Plex",
    note: "Engineered, a little typewriter in the details",
    display: `"IBM Plex Sans", ${SYSTEM_SANS}`,
    body: `"IBM Plex Sans", ${SYSTEM_SANS}`,
    mono: `"IBM Plex Mono", ${SYSTEM_MONO}`,
  },
  {
    id: "editorial",
    label: "Fraunces + Inter",
    note: "A warm serif for titles over clean Inter",
    display: `"Fraunces Variable", Georgia, serif`,
    body: `"Inter Variable", ${SYSTEM_SANS}`,
    mono: `"JetBrains Mono Variable", ${SYSTEM_MONO}`,
  },
  {
    id: "manrope",
    label: "Manrope",
    note: "Rounded and friendly",
    display: `"Manrope Variable", ${SYSTEM_SANS}`,
    body: `"Manrope Variable", ${SYSTEM_SANS}`,
    mono: `"JetBrains Mono Variable", ${SYSTEM_MONO}`,
  },
  {
    id: "system",
    label: "System",
    note: "The Mac's own San Francisco, as before",
    display: SYSTEM_SANS,
    body: SYSTEM_SANS,
    mono: SYSTEM_MONO,
  },
];

export function fontChoice(id: string | null | undefined): FontChoice {
  return FONTS.find((font) => font.id === id) ?? FONTS[0];
}

const REMEMBERED = "meridian.font";

export function rememberedFont(): string | null {
  try {
    return localStorage.getItem(REMEMBERED);
  } catch {
    return null;
  }
}

/** Point the page's font variables at a pairing, and remember it for the next launch. */
export function applyFont(id: string | null | undefined): void {
  const font = fontChoice(id);
  try {
    localStorage.setItem(REMEMBERED, font.id);
  } catch {
    // Only a convenience for the first paint.
  }
  const root = document.documentElement.style;
  root.setProperty("--font-display", font.display);
  root.setProperty("--font-body", font.body);
  root.setProperty("--mono", font.mono);
}
