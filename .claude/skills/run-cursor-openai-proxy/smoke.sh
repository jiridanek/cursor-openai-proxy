#!/usr/bin/env bash
# Driver for the run-cursor-openai-proxy skill.
#
# Deliberately thin: all actual functionality is the project's own
# tests/e2e.test.ts, run via the npm scripts declared for it. This script
# only chooses which one to run and checks that CURSOR_API_KEY is present
# before the --live path (which spends real Cursor agent-run time/cost).
#
# Usage:
#   .claude/skills/run-cursor-openai-proxy/smoke.sh          # no credentials needed
#   .claude/skills/run-cursor-openai-proxy/smoke.sh --live   # CURSOR_API_KEY required
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$ROOT"

LIVE=0
for arg in "$@"; do
  [ "$arg" = "--live" ] && LIVE=1
done

if [ ! -d node_modules ]; then
  echo "installing dependencies..."
  npm install
fi

if [ "$LIVE" = "1" ]; then
  : "${CURSOR_API_KEY:?--live requires CURSOR_API_KEY (a real Cursor account; spends real agent-run time)}"
  npm run test:e2e:live
else
  npm run test:e2e
fi
