#!/bin/bash
# macOS / Linux installer for the Scale Cases disclaimer worker.
# Installs Python deps, checks ffmpeg, and registers a launchd agent so the worker starts at login.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then echo "python3 not found. Install it (brew install python) and rerun."; exit 1; fi
"$PY" -m pip install -q --user -r "$HERE/requirements.txt" 2>/dev/null || "$PY" -m pip install -q --break-system-packages -r "$HERE/requirements.txt"
if ! command -v ffmpeg >/dev/null 2>&1; then echo "WARNING: ffmpeg is not on PATH; video jobs will fail until it is installed (brew install ffmpeg)."; fi
if [ "$(uname)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.scalecases.disclaimer-worker.plist"
  LOGDIR="$HOME/Library/Logs/ScaleCasesDisclaimers"; mkdir -p "$LOGDIR" "$HOME/Library/LaunchAgents"
  # PATH is set explicitly so launchd can find ffmpeg from Homebrew.
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.scalecases.disclaimer-worker</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$HERE/worker.py</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/worker.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/worker-error.log</string>
</dict></plist>
EOF
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  launchctl load "$PLIST"
  echo "Disclaimer worker installed. It runs on 127.0.0.1:43128 and starts at login (launchd: com.scalecases.disclaimer-worker)."
  echo "Logs: $LOGDIR   Stop: launchctl unload \"$PLIST\""
else
  echo "Installed Python deps. Start the worker with:  $PY \"$HERE/worker.py\""
fi
