#!/bin/zsh
# Double-click to start the Flow Studio panel. Close this window to stop it.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -d dist ] || npm run build
node dist/studio.js
