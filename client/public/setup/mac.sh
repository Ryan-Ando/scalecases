#!/bin/bash
# Scale Cases Helper setup for macOS: installs or updates the local helper that powers the
# Disclaimers tab and the local creative library (Ads Tracking / Relaunch).
# Run by "Scale Cases Setup.command" (double-click) or:
#   /bin/bash -c "$(curl -fsSL https://scalecases-client.onrender.com/setup/mac.sh)"
# Safe to run again at any time; that is also how to update.
set -euo pipefail

REPO_ZIP="${SC_REPO_ZIP:-https://github.com/Ryan-Ando/scalecases/archive/refs/heads/main.zip}"
APP="$HOME/Library/Application Support/ScaleCasesHelper"
LABEL="com.scalecases.helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/ScaleCasesHelper"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
say "Scale Cases Helper setup"

# 1. Homebrew (also installs Apple's command line tools). Asks for this Mac's password once.
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
if ! command -v brew >/dev/null 2>&1; then
  say "Installing Homebrew. Enter this Mac's login password when asked (nothing shows while typing). This can take 5-10 minutes."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
fi

# 2. Python and ffmpeg
say "Installing Python and ffmpeg (skipped if already installed)..."
brew list python@3.12 >/dev/null 2>&1 || brew install python@3.12
brew list ffmpeg >/dev/null 2>&1 || brew install ffmpeg
PY="$(brew --prefix python@3.12)/bin/python3.12"
BREW_BIN="$(brew --prefix)/bin"

# 3. The helper's code, from the Scale Cases repository
say "Downloading the latest helper..."
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$REPO_ZIP" -o "$TMP/sc.zip"
unzip -q "$TMP/sc.zip" "scalecases-main/tools/disclaimer-worker/*" -d "$TMP"
mkdir -p "$APP" "$LOGS" "$HOME/Library/LaunchAgents"
rm -rf "$APP/app.new"; mv "$TMP/scalecases-main/tools/disclaimer-worker" "$APP/app.new"
rm -rf "$APP/app.old"; [ -d "$APP/app" ] && mv "$APP/app" "$APP/app.old"; mv "$APP/app.new" "$APP/app"; rm -rf "$APP/app.old"

# 4. Python packages in the helper's own environment
say "Installing Python packages..."
[ -x "$APP/venv/bin/python" ] || "$PY" -m venv "$APP/venv"
"$APP/venv/bin/python" -m pip install -q --upgrade pip
"$APP/venv/bin/python" -m pip install -q -r "$APP/app/requirements.txt"

# 5. Replace older separate installs (disclaimer worker + Node creative library) with this one
for old in com.scalecases.disclaimer-worker com.scalecases.creative-library "$LABEL"; do
  launchctl bootout "gui/$(id -u)/$old" >/dev/null 2>&1 || launchctl unload "$HOME/Library/LaunchAgents/$old.plist" >/dev/null 2>&1 || true
done
rm -f "$HOME/Library/LaunchAgents/com.scalecases.disclaimer-worker.plist" "$HOME/Library/LaunchAgents/com.scalecases.creative-library.plist"

# 6. Start at login and keep running
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP/venv/bin/python</string><string>$APP/app/worker.py</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$BREW_BIN:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGS/helper.log</string>
  <key>StandardErrorPath</key><string>$LOGS/helper-error.log</string>
</dict></plist>
EOF
sleep 1
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"

# 7. Check it
say "Starting..."
HEALTH=""
for _ in $(seq 1 30); do
  HEALTH="$(curl -fs http://127.0.0.1:43128/health 2>/dev/null || true)"; [ -n "$HEALTH" ] && break; sleep 1
done
if [ -z "$HEALTH" ]; then
  echo "The helper did not start. Send this file to Ryan: $LOGS/helper-error.log"; exit 1
fi
"$APP/venv/bin/python" - "$HEALTH" <<'EOF'
import json, sys
h = json.loads(sys.argv[1])
ok = lambda b: "OK " if b else "!! "
print(f"{ok(True)}Helper running (version {h['version']})")
print(f"{ok(h['ffmpeg'])}ffmpeg" + ("" if h["ffmpeg"] else " missing: run  brew install ffmpeg"))
if h["library_root_ok"]:
    print(f"{ok(True)}Google Drive folder: {h['library_root']}")
else:
    print("!! Google Drive not found. Install Google Drive for desktop (google.com/drive/download), sign in with your")
    print("   cypressmediagroup.com account, then run this setup again.")
print(f"{ok(h['shared'])}Shared disclaimer data" + ("" if h["shared"] else ": ScaleCases/Disclaimers not found in Drive yet (check the Shared Drive is visible in Finder)"))
print(f"{ok(bool(h.get('creative_files')))}Creative library: {h.get('creative_files', 0)} files" + (f" in {h['creative_root']}" if h.get("creative_root") else "") + (f" ({h['creative_error']})" if h.get("creative_error") else ""))
EOF
say "Done. Open https://scalecases-client.onrender.com and, if Chrome asks, allow access to devices on your local network."
echo "The helper starts by itself when you log in. Run this setup again any time to update it."
