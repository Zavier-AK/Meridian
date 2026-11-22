/**
 * The moving ASCII layer behind the window: a field of characters, brighter where a
 * shape is, in two colours (the theme's accents unless the background has its own).
 *
 * Each style is a function from a point to a brightness and a tint; some also scatter
 * particles (petals, leaves) into a per-cell buffer first. Positions are a function of
 * time alone, so any moment can be drawn on its own: a still frame for Reduce Motion
 * is just one call.
 */
import type { BackgroundSettings } from "./types";

export type BackgroundStyle = BackgroundSettings["style"];

export const BACKGROUND_DEFAULTS: BackgroundSettings = {
  style: "liquid",
  intensity: 0.6,
  speed: 1,
  grain: 12,
  accent: null,
  accent_2: null,
};

export const BACKGROUND_STYLES: { id: BackgroundStyle; label: string; about: string }[] = [
  { id: "liquid", label: "Liquid", about: "Blobs of liquid drifting, merging and splitting." },
  { id: "tide", label: "Tide", about: "Layered swells rolling across, seen side on." },
  { id: "current", label: "Current", about: "A slow marbled current that never repeats." },
  { id: "ripple", label: "Ripple", about: "Drops landing on still water, rings spreading and crossing." },
  { id: "leaves", label: "Leaves", about: "Branches framing the window, swaying, the odd leaf falling." },
  { id: "sakura", label: "Sakura", about: "A blossom branch in the corner, petals tumbling down." },
  { id: "off", label: "Off", about: "No background." },
];

// ---------------------------------------------------------------- the setting in force

let current: BackgroundSettings = BACKGROUND_DEFAULTS;
const listeners = new Set<() => void>();

/** Show these settings; Settings calls it as you change them, the app once they're saved. */
export function applyBackground(settings: BackgroundSettings | undefined): void {
  current = settings ?? BACKGROUND_DEFAULTS;
  listeners.forEach((listener) => listener());
}
export function currentBackground(): BackgroundSettings {
  return current;
}
export function onBackgroundChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------- noise

// Gradient noise with a fixed permutation, so a given moment always looks the same.
const perm = new Uint8Array(512);
{
  let seed = 1337;
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) {
    seed = (seed * 16807) % 2147483647;
    const j = seed % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
function grad(h: number, x: number, y: number): number {
  switch (h & 7) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x;
    case 5: return -x;
    case 6: return y;
    default: return -y;
  }
}
/** Roughly 0..1. */
export function noise(x: number, y: number): number {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  x -= Math.floor(x);
  y -= Math.floor(y);
  const u = fade(x);
  const v = fade(y);
  const a = perm[X] + Y;
  const b = perm[X + 1] + Y;
  const l1 = grad(perm[a], x, y) + u * (grad(perm[b], x - 1, y) - grad(perm[a], x, y));
  const l2 = grad(perm[a + 1], x, y - 1) + u * (grad(perm[b + 1], x - 1, y - 1) - grad(perm[a + 1], x, y - 1));
  return (l1 + v * (l2 - l1)) * 0.7 + 0.5;
}
function fbm(x: number, y: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < 4; i++) {
    sum += amp * noise(x * freq, y * freq);
    freq *= 2;
    amp *= 0.5;
  }
  return sum / 0.9375;
}
const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const hash = (n: number) => {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};

// ---------------------------------------------------------------- the scene

/** One frame's world: grid size, time, pointer, and the particle buffers. */
type Scene = {
  cols: number;
  rows: number;
  aspect: number;
  t: number;
  pointer: { x: number; y: number } | null;
  buf: Float32Array;
  tint: Float32Array;
};
type Field = (x: number, y: number, s: Scene, i: number) => [number, number];

// Liquid.
const BLOBS = [...Array(7)].map((_, i) => ({
  a: 0.11 + i * 0.023,
  b: 0.083 + i * 0.031,
  p: i * 1.7,
  q: i * 2.3,
  r: 0.07 + (i % 3) * 0.035,
}));
const liquid: Field = (x, y, s) => {
  const { t, aspect } = s;
  // A shiver on the surface, so edges move like liquid rather than a drawn outline.
  const wx = x + 0.012 * (noise(x * 6, y * 6 + t * 0.6) - 0.5);
  const wy = y + 0.012 * (noise(x * 6 + 9, y * 6 - t * 0.6) - 0.5);
  let f = 0;
  let strongest = 0;
  let tint = 0;
  for (let i = 0; i < BLOBS.length; i++) {
    const b = BLOBS[i];
    const cx = aspect * (0.5 + 0.38 * Math.sin(t * b.a + b.p) + 0.06 * Math.sin(t * b.a * 3.1));
    const cy = 0.5 + 0.34 * Math.cos(t * b.b + b.q);
    const c = (b.r * b.r) / ((wx - cx) ** 2 + (wy - cy) ** 2 + 1e-4);
    f += c;
    if (c > strongest) {
      strongest = c;
      tint = i / (BLOBS.length - 1);
    }
  }
  if (s.pointer) {
    const c = 0.012 / ((wx - s.pointer.x) ** 2 + (wy - s.pointer.y) ** 2 + 1e-4);
    f += c;
    if (c > strongest) tint = 1;
  }
  const inside = smooth(0.9, 1.15, f);
  const depth = smooth(1.1, 4, f);
  const caustic = noise(wx * 14 + t * 0.4, wy * 14 - t * 0.3);
  const body = inside * (0.62 - 0.32 * depth + 0.28 * smooth(0.55, 0.8, caustic));
  const rim = Math.exp(-(((f - 1) / 0.16) ** 2));
  const haze = smooth(0.25, 1, f) * 0.14;
  return [Math.max(body, rim, haze), tint];
};

// Tide.
const tide: Field = (x, y, s) => {
  const { t } = s;
  let best = 0;
  let tint = 0;
  for (let i = 0; i < 6; i++) {
    const base = 0.28 + i * 0.125;
    // A swell with a steeper front (a sine skewed by itself), plus chop.
    const ph = x * 2.2 - t * (0.35 + i * 0.05) + i * 1.3;
    const swell = Math.sin(ph + 0.6 * Math.sin(ph));
    const crest =
      base +
      (0.07 + i * 0.014) * swell +
      0.018 * Math.sin(x * 7.3 + t * 0.9 + i * 2.1) +
      0.035 * (noise(x * 1.4 + i * 7, t * 0.1 + i) - 0.5);
    const d = y - crest;
    let v = Math.exp(-((d / 0.013) ** 2)) * (0.8 + 0.2 * swell);
    if (d > 0) v = Math.max(v, 0.5 * Math.exp(-d * 9) * (0.6 + 0.4 * noise(x * 8 - t * 0.3, y * 14)));
    if (d < 0 && d > -0.03) v = Math.max(v, 0.25 * (noise(x * 22 + t, y * 22) > 0.62 ? 1 : 0) * (1 + d / 0.03));
    v *= 0.62 + i * 0.08;
    if (v > best) {
      best = v;
      tint = i / 5;
    }
  }
  return [best, tint];
};

// Current.
const currentField: Field = (x, y, s) => {
  const { t } = s;
  const k = 1.6;
  const qx = fbm(x * k + t * 0.035, y * k);
  const qy = fbm(x * k + 5.2, y * k + 1.3 - t * 0.03);
  const r = fbm(x * k + 3.4 * qx + 1.7 + t * 0.02, y * k + 3.4 * qy + 9.2);
  const v = smooth(0.42, 0.78, r);
  const vein = Math.exp(-(((r - 0.62) / 0.012) ** 2)) * 0.8;
  return [Math.max(v * 0.7, vein), clamp((qx - 0.3) * 2)];
};

// Ripple: drops land on a schedule (so a still frame knows which are in flight), plus
// where the pointer moves.
type Drop = { x: number; y: number; born: number; life: number };
let pointerDrops: Drop[] = [];
const DROP_EVERY = 1.3;
function scheduledDrops(t: number, aspect: number): Drop[] {
  const out: Drop[] = [];
  for (let slot = Math.floor((t - 7) / DROP_EVERY); slot <= Math.floor(t / DROP_EVERY); slot++) {
    out.push({
      x: aspect * (0.1 + 0.8 * hash(slot * 0.71)),
      y: 0.12 + 0.76 * hash(slot * 1.37 + 5),
      born: slot * DROP_EVERY,
      life: 7,
    });
  }
  return out;
}
let dropsNow: Drop[] = [];
const ripple: Field = (x, y, s) => {
  const { t } = s;
  let v = 0.05 * smooth(0.55, 0.8, noise(x * 3 + t * 0.05, y * 3));
  let tint = 0;
  for (const d of dropsNow) {
    const age = t - d.born;
    const life = 1 - age / d.life;
    if (age < 0 || life <= 0) continue;
    const dist = Math.hypot(x - d.x, y - d.y);
    for (let k = 0; k < 3; k++) {
      const front = age * 0.11 - k * 0.035;
      if (front <= 0) continue;
      const ring = Math.exp(-(((dist - front) / 0.011) ** 2)) * life * (1 - k * 0.3);
      if (ring > v) {
        v = ring;
        tint = clamp(age / d.life + k * 0.2);
      }
    }
  }
  return [v, tint];
};

// Falling things: an ellipse whose width swings as it turns over.
function splat(s: Scene, px: number, py: number, len: number, wid: number, rot: number, bright: number, tint: number) {
  const { cols, rows, aspect } = s;
  const cx = (px / aspect) * cols;
  const cy = py * rows;
  const spanR = len * rows + 1;
  const spanC = (len / aspect) * cols + 1;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  for (let r = Math.max(0, Math.floor(cy - spanR)); r <= Math.min(rows - 1, Math.ceil(cy + spanR)); r++) {
    for (let c = Math.max(0, Math.floor(cx - spanC)); c <= Math.min(cols - 1, Math.ceil(cx + spanC)); c++) {
      const dx = ((c + 0.5) / cols) * aspect - px;
      const dy = (r + 0.5) / rows - py;
      const u = dx * cos + dy * sin;
      const w = -dx * sin + dy * cos;
      const q = 1 - (u / len) ** 2 - (w / wid) ** 2;
      if (q <= 0) continue;
      const v = bright * (0.55 + 0.45 * q);
      const i = r * cols + c;
      if (v > s.buf[i]) {
        s.buf[i] = v;
        s.tint[i] = tint;
      }
    }
  }
}
function falling(s: Scene, count: number, kind: "leaf" | "petal") {
  const { t, aspect } = s;
  const leaf = kind === "leaf";
  for (let n = 0; n < count; n++) {
    const depth = 0.45 + 0.55 * hash(n * 3.1); // far ones smaller, dimmer, slower
    const fall = (leaf ? 0.035 : 0.05) * (0.6 + depth);
    const drift = (leaf ? 0.01 : 0.035) * (0.5 + depth);
    const period = 1.25;
    const phase = (hash(n * 7.7) + (t * fall) / period) % 1;
    const py = -0.1 + phase * period;
    const sway = leaf
      ? 0.06 * Math.sin(t * 1.3 + n * 4.1) // a leaf zigzags down like a pendulum
      : 0.025 * Math.sin(t * 0.9 + n * 2.3) + 0.012 * Math.sin(t * 2.3 + n);
    const wrap = aspect + 0.4;
    let px = (hash(n * 1.9) * wrap - 0.2 + t * drift + sway) % wrap;
    if (px < -0.2) px += wrap;
    const turn = Math.sin(t * (leaf ? 1.3 : 1.7 + hash(n) * 1.5) + n * 5.3);
    const rot = leaf ? 0.9 * Math.cos(t * 1.3 + n * 4.1) : t * (0.6 + hash(n * 2.2)) + n;
    const size = (leaf ? 0.028 : 0.02) * (0.55 + 0.6 * depth);
    splat(s, px, py, size, size * (0.25 + 0.4 * Math.abs(turn)), rot, 0.45 + 0.55 * depth,
      leaf ? 0.35 + 0.6 * hash(n * 9.3) : 0.6 + 0.4 * hash(n * 5.1));
  }
}

// Leaves: a tree reaching in from each top corner.
function canopy(x: number, y: number, t: number, aspect: number, side: -1 | 1): [number, number] | null {
  const ax = side < 0 ? -0.06 : aspect + 0.06;
  const ay = -0.08;
  let px = x - ax;
  let py = y - ay;
  const dist = Math.hypot(px, py);
  const R = 0.8;
  if (dist > R + 0.1) return null;
  // The further from the trunk, the more it moves.
  const sway = (0.05 * Math.sin(t * 0.6 + side) + 0.025 * Math.sin(t * 1.55 + dist * 5 + side)) * dist;
  const cs = Math.cos(sway);
  const sn = Math.sin(sway);
  [px, py] = [px * cs - py * sn, px * sn + py * cs];
  const inward = -side; // both trees reach towards the middle
  const ang = Math.atan2(py, inward * px);
  const edge = R * (0.8 + 0.35 * (noise(ang * 3.2 + side * 11, 3.3) - 0.5)) * (0.55 + 0.45 * Math.cos(ang - 0.55));
  const inside = smooth(edge + 0.02, edge - 0.08, dist);
  if (inside <= 0) return null;
  const leaf = fbm(px * 6 + side * 20, py * 6);
  let v = smooth(0.4, 0.52, leaf) * inside * (0.45 + 0.4 * smooth(0.5, 0.75, leaf));
  // A gust crossing the window flips leaves over as it passes.
  const gx = ((t * 0.12) % 1.6) * (aspect + 1) - 0.5;
  const gust = Math.exp(-(((x - gx) / 0.22) ** 2));
  if (v > 0 && noise(px * 24, py * 24 + t * 2.2) > 0.68) v = Math.min(1, v + 0.45 * gust + 0.12);
  // Branches show through the gaps.
  let branch = 0;
  for (let k = 0; k < 4; k++) {
    const a = 0.3 + k * 0.32 + 0.08 * Math.sin(k * 3.7);
    const along = px * inward * Math.cos(a) + py * Math.sin(a);
    if (along < 0 || along > edge * 0.9) continue;
    const across = -px * inward * Math.sin(a) + py * Math.cos(a) + 0.03 * Math.sin(along * 9 + k);
    const width = 0.014 * (1 - along / edge) + 0.003;
    branch = Math.max(branch, smooth(width, width * 0.4, Math.abs(across)) * 0.7);
  }
  return [Math.max(v, branch * (v > 0.3 ? 0.4 : 1)), branch > v ? 0 : 0.35 + 0.65 * noise(px * 3, py * 3 + side)];
}
const leaves: Field = (x, y, s, i) => {
  let best = s.buf[i];
  let tint = s.tint[i];
  for (const side of [-1, 1] as const) {
    const got = canopy(x, y, s.t, s.aspect, side);
    if (got && got[0] > best) [best, tint] = got;
  }
  return [best, tint];
};

// Sakura: a blossom branch reaching in from the top right.
const sakura: Field = (x, y, s, i) => {
  const { t, aspect } = s;
  let best = s.buf[i];
  let tint = s.tint[i];
  // Cheap reject: the branch and its blossom stay in the top right.
  if (x < aspect - 0.75 || y > 0.42) return [best, tint];
  const sway = 0.012 * Math.sin(t * 0.7) + 0.006 * Math.sin(t * 1.9);
  for (let k = 0; k <= 50; k++) {
    const u = k / 50;
    const bx = aspect + 0.02 - u * 0.62;
    const by = 0.04 + u * 0.2 + 0.07 * Math.sin(u * 3) + sway * u * 3;
    const w = 0.016 * (1 - u) + 0.004;
    if (Math.hypot(x - bx, y - by) < w && 0.62 > best) {
      best = 0.62;
      tint = 0;
    }
  }
  for (let k = 0; k < 9; k++) {
    const u = 0.1 + k * 0.1;
    const bx = aspect + 0.02 - u * 0.62 + 0.03 * Math.sin(k * 5.1);
    const by = 0.04 + u * 0.2 + 0.07 * Math.sin(u * 3) + sway * u * 3 + 0.04 * Math.cos(k * 3.3);
    const rad = 0.05 + 0.03 * hash(k * 4.4);
    const d = Math.hypot(x - bx, y - by);
    if (d > rad) continue;
    const petal = fbm(x * 30 + k, y * 30);
    const v = smooth(rad, rad * 0.35, d) * (0.4 + 0.6 * smooth(0.4, 0.65, petal));
    if (v > best) {
      best = v;
      tint = 0.65 + 0.35 * petal;
    }
  }
  return [best, tint];
};

const FIELDS: Record<Exclude<BackgroundStyle, "off">, Field> = {
  liquid,
  tide,
  current: currentField,
  ripple,
  leaves,
  sakura,
};
const PREPARE: Partial<Record<BackgroundStyle, (s: Scene) => void>> = {
  leaves: (s) => falling(s, 7, "leaf"),
  sakura: (s) => falling(s, 46, "petal"),
  ripple: (s) => {
    pointerDrops = pointerDrops.filter((d) => s.t - d.born < d.life && s.t >= d.born);
    dropsNow = [...scheduledDrops(s.t, s.aspect), ...pointerDrops];
  },
};

// ---------------------------------------------------------------- drawing

const RAMP = " .·:-=+*≈#%@".split("");
const TINTS = 5;

/** A colour any CSS can name, as RGB, via the canvas's own parser. */
function rgb(ctx: AnyContext, colour: string): [number, number, number] | null {
  ctx.fillStyle = "#000";
  ctx.fillStyle = colour;
  const parsed = ctx.fillStyle;
  if (parsed.startsWith("#") && parsed.length === 7) {
    return [1, 3, 5].map((i) => parseInt(parsed.slice(i, i + 2), 16)) as [number, number, number];
  }
  const m = parsed.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

export type Renderer = {
  /** Draw the moment `t` (seconds of scene time). */
  draw: (t: number) => void;
  resize: (width: number, height: number, dpr: number) => void;
  setSettings: (settings: BackgroundSettings, accent: string, accent2: string) => void;
  pointer: (x: number, y: number, t: number) => void;
  pointerLeft: () => void;
};

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type AnyContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function createRenderer(canvas: AnyCanvas): Renderer {
  const ctx = canvas.getContext("2d") as AnyContext;
  // Nothing to draw until the first settings arrive with their colours.
  let settings: BackgroundSettings = { ...BACKGROUND_DEFAULTS, style: "off" };
  let width = 0;
  let height = 0;
  let cols = 0;
  let rows = 0;
  let cw = 0;
  let ch = 0;
  let styles: string[][] = [];
  let pointer: Scene["pointer"] = null;
  let buf = new Float32Array(0);
  let tint = new Float32Array(0);
  const buckets = new Map<number, number[]>();

  function layout() {
    ch = settings.grain;
    cw = Math.round(settings.grain * 0.6);
    cols = Math.ceil(width / cw);
    rows = Math.ceil(height / ch);
    buf = new Float32Array(cols * rows);
    tint = new Float32Array(cols * rows);
  }

  return {
    resize(w, h, dpr) {
      width = w;
      height = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      layout();
    },
    setSettings(next, accent, accent2) {
      const regrid = next.grain !== settings.grain;
      settings = next;
      if (regrid) layout();
      const a = rgb(ctx, accent) ?? [255, 158, 187];
      const b = rgb(ctx, accent2) ?? a;
      styles = [];
      for (let g = 0; g < TINTS; g++) {
        const m = g / (TINTS - 1);
        const c = a.map((v, i) => Math.round(v + (b[i] - v) * m));
        styles.push(
          RAMP.map((_, k) => `rgba(${c[0]},${c[1]},${c[2]},${((0.14 + 0.86 * (k / (RAMP.length - 1)) ** 0.8) * settings.intensity).toFixed(3)})`),
        );
      }
    },
    pointer(x, y, t) {
      const aspect = width / height;
      pointer = { x: (x / width) * aspect, y: y / height };
      if (settings.style === "ripple" && Math.random() < 0.06) {
        pointerDrops.push({ x: pointer.x, y: pointer.y, born: t, life: 5 });
      }
    },
    pointerLeft() {
      pointer = null;
    },
    draw(t) {
      ctx.clearRect(0, 0, width, height);
      if (settings.style === "off" || !cols || !rows || styles.length === 0) return;
      const field = FIELDS[settings.style];
      const scene: Scene = { cols, rows, aspect: width / height, t, pointer, buf, tint };
      buf.fill(0);
      PREPARE[settings.style]?.(scene);
      ctx.font = `${settings.grain - 1}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.textBaseline = "top";
      buckets.clear();
      for (let r = 0; r < rows; r++) {
        const y = (r + 0.5) / rows;
        for (let c = 0; c < cols; c++) {
          const x = ((c + 0.5) / cols) * scene.aspect;
          const [v, g] = field(x, y, scene, r * cols + c);
          const k = Math.min(RAMP.length - 1, Math.floor(clamp(v) * RAMP.length));
          if (k === 0) continue;
          const key = Math.round(clamp(g) * (TINTS - 1)) * 64 + k;
          let list = buckets.get(key);
          if (!list) buckets.set(key, (list = []));
          list.push(c, r);
        }
      }
      // One fill style per colour: thousands of glyphs, a few dozen state changes.
      for (const [key, list] of buckets) {
        const k = key % 64;
        ctx.fillStyle = styles[(key - k) / 64][k];
        const glyph = RAMP[k];
        for (let i = 0; i < list.length; i += 2) ctx.fillText(glyph, list[i] * cw, list[i + 1] * ch);
      }
    },
  };
}

// ---------------------------------------------------------------- the loop

/** What drives the background, on the page or in a worker: the same calls either way. */
export type Driver = {
  resize: (width: number, height: number, dpr: number) => void;
  settings: (settings: BackgroundSettings, accent: string, accent2: string) => void;
  pointer: (x: number, y: number) => void;
  pointerLeft: () => void;
  /** Frames a second (0 pauses), and whether to hold a single still frame. */
  mode: (fps: number, still: boolean) => void;
  stop: () => void;
};

/** Runs a renderer: a frame every 1/fps seconds, or one still frame when it shouldn't move. */
export function createLoop(renderer: Renderer): Driver {
  let clock = 0;
  let style: BackgroundStyle = "off";
  let speed = 1;
  let fps = 30;
  let still = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = 0;

  const frame = () => {
    const now = performance.now();
    clock += Math.min(0.1, (now - last) / 1000) * speed;
    last = now;
    renderer.draw(clock);
    timer = setTimeout(frame, 1000 / fps);
  };
  const restart = () => {
    clearTimeout(timer);
    timer = undefined;
    if (style === "off" || still || speed === 0 || fps === 0) {
      renderer.draw(clock);
      return;
    }
    last = performance.now();
    frame();
  };

  return {
    resize(width, height, dpr) {
      renderer.resize(width, height, dpr);
      renderer.draw(clock);
    },
    settings(next, accent, accent2) {
      renderer.setSettings(next, accent, accent2);
      const moved = next.style !== style || next.speed !== speed;
      style = next.style;
      speed = next.speed;
      if (moved || !timer) restart();
    },
    pointer(x, y) {
      renderer.pointer(x, y, clock);
    },
    pointerLeft() {
      renderer.pointerLeft();
    },
    mode(nextFps, nextStill) {
      if (nextFps === fps && nextStill === still) return;
      fps = nextFps;
      still = nextStill;
      restart();
    },
    stop() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
