# Meridian home — README hero

Made with the [Stageshow](https://benji.org/stageshow) skill (`.claude/skills/stageshow`).
The output is `docs/screenshots/home.png`, 1920 × 1080: a 960 × 540 stage at 2×.

## Regenerate

1. Copy this folder to `.claude/skills/stageshow/examples/meridian-home/` (the kit
   import, `../../kit`, resolves from there), then run `npm install` and `npm run dev`
   in `.claude/skills/stageshow`.
2. Check it: `node scripts/film.mjs "<preview>/?capture=meridian-home" --select '#example' --still --out home.png`.
   It should end with `no-issues-detected`.
3. Capture the PNG with transparent corners: `node capture.cjs ../../docs/screenshots/home.png`
   (point the URL inside at your preview's port).

## What it is

- **Closest gold:** `static-card` for the frame (a window pinned top-left, bleeding off
  two edges, with a satellite card) and `ai-chat` for the thread.
- **The story:** a request in the home chat, the head agent's reply, Meridian's notice
  that the worker finished, and the change waiting for review. The review card is the
  payoff, over the window's empty right margin, covering nothing it explains.
- **Real strings:** the request, the reply, the notice, the card's title, the file name
  and the two buttons. The earlier turns and the other projects in the rail are filler.
- **Look:** Meridian's Ember theme (base `#0c0c0e`, accent `#ff7a1a`, second accent
  `#ffc43d`) mapped onto the kit's dark tokens; the Cells mark is the app's own.

## Not checked

- A still only: no motion, so no loop or `--gate` run.
- No compact (phone-width) design. The README shows a fixed PNG that scales down, so
  it is never laid out at 358 px.
