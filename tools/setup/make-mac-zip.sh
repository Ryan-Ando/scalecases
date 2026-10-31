#!/bin/bash
# Rebuilds client/public/setup/ScaleCases-Setup-Mac.zip. The .command goes inside a zip because a
# plain download loses its executable bit; Archive Utility restores it on unzip.
set -e
cd "$(dirname "$0")"
chmod +x "Scale Cases Setup.command"
rm -f ../../client/public/setup/ScaleCases-Setup-Mac.zip
zip -q -X ../../client/public/setup/ScaleCases-Setup-Mac.zip "Scale Cases Setup.command"
