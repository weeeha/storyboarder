#!/usr/bin/env bash
# Build the Shot Generator bundle and run this fork from source.
#   tools/dev.sh [path/to/project.storyboarder]
#
# Node 22 (Homebrew node@22); webpack 4 needs the legacy OpenSSL provider.
# Dev runs keep their settings in ~/Library/Application Support/Storyboarder-Dev,
# separate from an installed Storyboarder.
# DevTools on port 9223 lets tools/cdp.mjs inspect the windows. Don't point
# macOS accessibility tools (screen readers, dictation apps, screen-control
# agents) at this window: Electron 18 crashes on accessibility queries under macOS 26.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
NODE_OPTIONS=--openssl-legacy-provider npx webpack --mode=development \
  --config configs/shot-generator/webpack.config.js | grep -E "ERROR|shot-generator.js " || true
NODE_ENV=development exec npx electron . ${1:+"$1"} --remote-debugging-port=9223
