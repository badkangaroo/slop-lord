#!/usr/bin/env bash
# =============================================================================
# scripts/launch-chrome.sh
#
# Launches Google Chrome with:
#   - Remote debugging enabled on the configured CDP port
#   - A persistent profile directory so TikTok session cookies survive restarts
#   - The window fully visible (NOT headless) so the human can log in
#
# USAGE
#   ./scripts/launch-chrome.sh          # first run: browser opens, log in to TikTok
#   ./scripts/launch-chrome.sh          # subsequent runs: session is restored
#
# FIRST-TIME SETUP
#   1. Run this script
#   2. Log in to TikTok in the browser window that opens
#   3. Leave the window open and start the agent: npm run agent
#
# The agent will attach to this window via CDP and take over navigation.
# You can grab the mouse at any time to interact manually.
# To pause the agent: touch /tmp/slop-lord.pause
# To resume:          rm /tmp/slop-lord.pause
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Read config from runtime.yaml (requires python3 or yq; falls back to defaults)
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$REPO_ROOT/config/runtime.yaml"

# Default values (match config/runtime.yaml)
CDP_PORT=9222
PROFILE_DIR="$HOME/.slop-lord/chrome-profile"

# Try to read from runtime.yaml using python3 (available on macOS + most Linux)
if command -v python3 &>/dev/null && [ -f "$CONFIG_FILE" ]; then
  CDP_PORT_FROM_CONFIG=$(python3 -c "
import sys
try:
    import yaml
    with open('$CONFIG_FILE') as f:
        c = yaml.safe_load(f)
    print(c.get('browser', {}).get('cdpPort', $CDP_PORT))
except Exception:
    print($CDP_PORT)
" 2>/dev/null || echo "$CDP_PORT")
  CDP_PORT="${CDP_PORT_FROM_CONFIG:-$CDP_PORT}"

  PROFILE_FROM_CONFIG=$(python3 -c "
import sys, os
try:
    import yaml
    with open('$CONFIG_FILE') as f:
        c = yaml.safe_load(f)
    p = c.get('browser', {}).get('profileDir', '$PROFILE_DIR')
    print(p.replace('~', os.path.expanduser('~')))
except Exception:
    print('$PROFILE_DIR')
" 2>/dev/null || echo "$PROFILE_DIR")
  PROFILE_DIR="${PROFILE_FROM_CONFIG:-$PROFILE_DIR}"
fi

# Allow env var overrides
CDP_PORT="${BROWSER_CDP_PORT:-$CDP_PORT}"
PROFILE_DIR="${CHROME_PROFILE_DIR:-$PROFILE_DIR}"

# ---------------------------------------------------------------------------
# Ensure profile directory exists
# ---------------------------------------------------------------------------

mkdir -p "$PROFILE_DIR"

# ---------------------------------------------------------------------------
# Detect Chrome executable
# ---------------------------------------------------------------------------

CHROME=""

case "$(uname -s)" in
  Darwin)
    # macOS — try standard locations
    for candidate in \
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      "/Applications/Chromium.app/Contents/MacOS/Chromium" \
      "$(which google-chrome 2>/dev/null || true)" \
      "$(which chromium 2>/dev/null || true)" \
      "$(which chromium-browser 2>/dev/null || true)"; do
      if [ -x "$candidate" ]; then
        CHROME="$candidate"
        break
      fi
    done
    ;;
  Linux)
    for candidate in \
      "$(which google-chrome 2>/dev/null || true)" \
      "$(which google-chrome-stable 2>/dev/null || true)" \
      "$(which chromium-browser 2>/dev/null || true)" \
      "$(which chromium 2>/dev/null || true)" \
      "/usr/bin/google-chrome" \
      "/usr/bin/chromium-browser" \
      "/usr/bin/chromium"; do
      if [ -x "$candidate" ]; then
        CHROME="$candidate"
        break
      fi
    done
    ;;
  *)
    echo "❌  Unsupported OS: $(uname -s)"
    exit 1
    ;;
esac

if [ -z "$CHROME" ]; then
  echo ""
  echo "❌  Could not find Google Chrome or Chromium."
  echo ""
  echo "    macOS:  Install from https://www.google.com/chrome/"
  echo "    Linux:  sudo apt install google-chrome-stable"
  echo "            or: sudo apt install chromium-browser"
  echo ""
  exit 1
fi

# ---------------------------------------------------------------------------
# Check if Chrome is already running on the CDP port
# ---------------------------------------------------------------------------

if curl -sf "http://localhost:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  echo ""
  echo "✓  Chrome is already running on port ${CDP_PORT}."
  echo "   Profile: ${PROFILE_DIR}"
  echo ""
  echo "   If TikTok is open and you're logged in, start the agent:"
  echo "   npm run agent"
  echo ""
  exit 0
fi

# ---------------------------------------------------------------------------
# Launch Chrome
# ---------------------------------------------------------------------------

echo ""
echo "  Launching Chrome..."
echo "  CDP port:   ${CDP_PORT}"
echo "  Profile:    ${PROFILE_DIR}"
echo "  Executable: ${CHROME}"
echo ""
echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │  NEXT STEPS                                             │"
echo "  │                                                         │"
echo "  │  1. The browser window is opening now.                  │"
echo "  │  2. Navigate to https://www.tiktok.com and log in.      │"
echo "  │  3. Leave this window open.                             │"
echo "  │  4. In a new terminal, run:  npm run agent              │"
echo "  │                                                         │"
echo "  │  The agent will attach automatically after login.       │"
echo "  │  To pause the agent at any time:                        │"
echo "  │    touch /tmp/slop-lord.pause                           │"
echo "  │  To resume:                                             │"
echo "  │    rm /tmp/slop-lord.pause                              │"
echo "  └─────────────────────────────────────────────────────────┘"
echo ""

# Launch Chrome in the background so this script returns to the shell.
# --no-first-run        suppress the "Welcome to Chrome" overlay
# --no-default-browser-check  suppress the default browser prompt
# --disable-features=Translate  suppress translation prompts
"$CHROME" \
  --remote-debugging-port="${CDP_PORT}" \
  --user-data-dir="${PROFILE_DIR}" \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=Translate \
  --window-size=1280,800 \
  "https://www.tiktok.com" &

CHROME_PID=$!
echo "  Chrome PID: ${CHROME_PID}"
echo "  (Chrome is running in the background; this terminal is free)"
echo ""

# Give Chrome a moment to start, then verify CDP is reachable
sleep 3
if curl -sf "http://localhost:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  echo "✓  CDP is listening on port ${CDP_PORT}. Ready for the agent."
else
  echo "⚠  Chrome started (PID ${CHROME_PID}) but CDP is not yet reachable."
  echo "   This is normal on slower machines. The agent will wait for it."
fi
echo ""
