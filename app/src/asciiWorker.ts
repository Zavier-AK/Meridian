/// <reference lib="webworker" />
/**
 * The ASCII background, drawn off the page's thread so it never competes with typing,
 * scrolling or the chat streaming in. The page sends what changes; this draws.
 */
import { createLoop, createRenderer, type Driver } from "./asciiEngine";

let driver: Driver | null = null;

self.onmessage = (event: MessageEvent) => {
  const m = event.data;
  if (m.type === "init") {
    driver = createLoop(createRenderer(m.canvas as OffscreenCanvas));
    return;
  }
  if (!driver) return;
  switch (m.type) {
    case "resize":
      driver.resize(m.width, m.height, m.dpr);
      break;
    case "settings":
      driver.settings(m.settings, m.accent, m.accent2);
      break;
    case "pointer":
      driver.pointer(m.x, m.y);
      break;
    case "leave":
      driver.pointerLeft();
      break;
    case "mode":
      driver.mode(m.fps, m.still);
      break;
    case "stop":
      driver.stop();
      break;
  }
};
