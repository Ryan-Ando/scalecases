#!/bin/bash
# macOS installer for the read-only local creative library helper.
# Usage: bash tools/creative-library/install.sh "/Users/you/Library/CloudStorage/GoogleDrive-you@example.com/My Drive/2026 B2C"
set -e
ROOT="$1"
if [ -z "$ROOT" ] || [ ! -d "$ROOT" ]; then echo "Usage: $0 \"<path to the 2026 B2C folder>\"  (folder must exist)"; exit 1; fi
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "node not found. Install it (brew install node) and rerun."; exit 1; fi
HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL="$HOME/Library/Application Support/ScaleCasesCreativeLibrary"
mkdir -p "$INSTALL" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/ScaleCasesCreativeLibrary"
cp "$HERE/helper.mjs" "$INSTALL/helper.mjs"
ROOT_ABS="$(cd "$ROOT" && pwd)"
cat > "$INSTALL/config.json" <<EOF
{ "root": "$ROOT_ABS", "port": 43127, "origins": ["https://scalecases-client.onrender.com"], "intervalMs": 60000 }
EOF
PLIST="$HOME/Library/LaunchAgents/com.scalecases.creative-library.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.scalecases.creative-library</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$INSTALL/helper.mjs</string><string>--config</string><string>$INSTALL/config.json</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/ScaleCasesCreativeLibrary/helper.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/ScaleCasesCreativeLibrary/helper-error.log</string>
</dict></plist>
EOF
launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl load "$PLIST"
echo "Creative library helper installed for \"$ROOT_ABS\" on 127.0.0.1:43127; starts at login (launchd: com.scalecases.creative-library)."
echo "Stop: launchctl unload \"$PLIST\""
