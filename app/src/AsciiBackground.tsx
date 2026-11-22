import { useEffect, useRef, useSyncExternalStore } from "react";
import { createLoop, createRenderer, currentBackground, onBackgroundChange, type Driver } from "./asciiBackground";

/** Frames a second while the window is in front, and while it's behind another. */
const FPS_FOCUSED = 30;
const FPS_UNFOCUSED = 10;

/**
 * The ASCII background, fixed behind everything.
 *
 * It's drawn in a worker on an OffscreenCanvas where the system has one, so it never
 * takes time from the page; elsewhere the same loop runs here. It holds a single frame
 * when the system asks for reduced motion or the speed is 0, and stops while the
 * window is hidden.
 */
export default function AsciiBackground() {
  const settings = useSyncExternalStore(onBackgroundChange, currentBackground);
  const host = useRef<HTMLDivElement>(null);
  const driver = useRef<Driver | null>(null);

  // The canvas and whatever draws on it. Made here rather than rendered, because a
  // canvas handed to a worker can't be handed over twice.
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const canvas = document.createElement("canvas");
    parent.appendChild(canvas);
    driver.current = startDriver(canvas);
    const d = driver.current;

    const fit = () => d.resize(window.innerWidth, window.innerHeight, Math.min(window.devicePixelRatio || 1, 2));
    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    const mode = () =>
      d.mode(document.hidden ? 0 : document.hasFocus() ? FPS_FOCUSED : FPS_UNFOCUSED, still.matches);
    const move = (event: PointerEvent) => d.pointer(event.clientX, event.clientY);
    const leave = () => d.pointerLeft();
    fit();
    mode();
    window.addEventListener("resize", fit);
    window.addEventListener("focus", mode);
    window.addEventListener("blur", mode);
    document.addEventListener("visibilitychange", mode);
    still.addEventListener("change", mode);
    window.addEventListener("pointermove", move);
    document.documentElement.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener("focus", mode);
      window.removeEventListener("blur", mode);
      document.removeEventListener("visibilitychange", mode);
      still.removeEventListener("change", mode);
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
      d.stop();
      canvas.remove();
      driver.current = null;
    };
  }, []);

  // Settings and colours: the background's own colours, else the theme's accents,
  // followed as the theme changes.
  useEffect(() => {
    const send = () => {
      const css = getComputedStyle(document.documentElement);
      driver.current?.settings(
        settings,
        settings.accent ?? css.getPropertyValue("--accent").trim(),
        settings.accent_2 ?? css.getPropertyValue("--accent-2").trim(),
      );
    };
    send();
    const watch = new MutationObserver(send);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    return () => watch.disconnect();
  }, [settings]);

  return <div ref={host} className="ascii-background" aria-hidden="true" />;
}

/** A worker drawing on the canvas where that's possible, else a loop on this page. */
function startDriver(canvas: HTMLCanvasElement): Driver {
  if (typeof canvas.transferControlToOffscreen === "function" && typeof Worker !== "undefined") {
    try {
      // The worker first: once the canvas is handed over, this page can't draw on it.
      const worker = new Worker(new URL("./asciiWorker.ts", import.meta.url), { type: "module" });
      const offscreen = canvas.transferControlToOffscreen();
      worker.postMessage({ type: "init", canvas: offscreen }, [offscreen]);
      return {
        resize: (width, height, dpr) => worker.postMessage({ type: "resize", width, height, dpr }),
        settings: (settings, accent, accent2) => worker.postMessage({ type: "settings", settings, accent, accent2 }),
        pointer: (x, y) => worker.postMessage({ type: "pointer", x, y }),
        pointerLeft: () => worker.postMessage({ type: "leave" }),
        mode: (fps, still) => worker.postMessage({ type: "mode", fps, still }),
        stop: () => worker.terminate(),
      };
    } catch {
      // Fall through to drawing here.
    }
  }
  return createLoop(createRenderer(canvas));
}
