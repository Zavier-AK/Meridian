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
# A Conda environment puts its own compilers and build tools first, which breaks the C++
# build of the voice engine; build with the system's.
if [ -n "$CONDA_PREFIX" ]; then
  PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v "^$CONDA_PREFIX" | paste -sd: -)"
  export PATH
  unset CONDA_PREFIX CC CXX AR LD CFLAGS CXXFLAGS LDFLAGS
fi
# CMake keeps the macOS version it first configured with. A voice engine (whisper.cpp)
# configured for an older macOS before the minimum was raised fails the same way on
# every rebuild until Cargo rebuilds it from scratch.
if grep -Eqs '^CMAKE_OSX_DEPLOYMENT_TARGET:[A-Z]*=10\.(1[0-4]|[0-9])$' \
  "$ROOT"/app/src-tauri/target/release/build/whisper-rs-sys-*/out/build/CMakeCache.txt; then
  echo "→ Rebuilding the voice engine, configured earlier for an older macOS"
  (cd "$ROOT/app/src-tauri" && cargo clean --release -p whisper-rs-sys)
fi

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
