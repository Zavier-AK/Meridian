#!/bin/sh
# Build Meridian and install it in /Applications, so it opens from Launchpad, Spotlight
# or the Dock like any other app. Run it again to update: it pulls the latest code first.
#
#   ./scripts/install-mac.sh            pull, build, install, open
#   ./scripts/install-mac.sh --no-pull  build what's checked out
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Meridian.app"
BUILT="$ROOT/app/src-tauri/target/release/bundle/macos/$APP_NAME"
DEST="/Applications/$APP_NAME"

if [ "$(uname)" != "Darwin" ]; then
  echo "This installs the Mac app; on other systems run: cd app && npm run tauri build" >&2
  exit 1
fi

cd "$ROOT"
if [ "$1" != "--no-pull" ] && git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  echo "→ Pulling the latest code"
  git pull --ff-only || echo "  (couldn't fast-forward; building what's checked out)"
fi

echo "→ Building (a few minutes the first time; much faster after)"
cd "$ROOT/app"
npm install --no-audit --no-fund
npm run tauri build -- --bundles app

if [ ! -d "$BUILT" ]; then
  echo "The build finished but $BUILT isn't there." >&2
  exit 1
fi

if pgrep -xq Meridian; then
  echo "→ Quitting the running Meridian"
  osascript -e 'quit app "Meridian"' >/dev/null 2>&1 || true
  sleep 2
fi

echo "→ Installing to $DEST"
rm -rf "$DEST"
ditto "$BUILT" "$DEST"

echo "✓ Installed. Opening Meridian; right-click its Dock icon → Options → Keep in Dock."
open "$DEST"
