#!/bin/sh
# Run this to start the Flow Studio panel on Linux (double-click it, or `./Flow\ Studio.sh`).
# Close this window, or press Ctrl+C, to stop it.
cd "$(dirname "$0")" || exit 1
[ -d dist ] || npm run build || exit 1
exec node dist/studio.js
