---
name: screenshots
description: See what a UI change looks like by screenshotting the running page with headless Chrome. Use after changing anything visual (layout, styles, components) and before reporting the work done.
---

# Look at what you built

Reading the code tells you what you meant. A screenshot tells you what happened. After a
visual change, look at it.

1. **Start the app** if it isn't running (the project's dev command, such as
   `npm run dev`), in the background, and note the port it prints.
2. **Take the screenshot** with the Chrome already on this Mac. Use your own file name, so
   that workers running at once don't overwrite each other:

   ```sh
   CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
   "$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=1280,800 \
     --virtual-time-budget=5000 --screenshot=/tmp/shot-$$.png http://localhost:5173/
   ```

   Use the real port and path. Add `--window-size=390,844` to check a phone width.
   Chromium, Brave or Edge work the same way, if Chrome isn't installed.
3. **Look at it**: open the PNG with your Read tool. You see the image, and so does the
   person: every image you open appears in Meridian's chat.
4. **Compare it with what was asked.** If the task came with a screenshot or mockup, open
   that too and check them side by side. Fix what doesn't match before you report.

Only screenshot pages on this machine (`localhost`), never outside sites. Stop any dev
server you started when you're done.
