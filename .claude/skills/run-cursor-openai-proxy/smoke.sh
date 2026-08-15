#!/usr/bin/env bash
# Driver for the run-cursor-openai-proxy skill.
#
# Two modes, auto-selected:
#   1. USE_LIVE=1 (or --live): drive an already-running instance (default
#      http://127.0.0.1:11434) with real POST requests. Requires that
#      instance to be in "hosted" auth mode with a real Cursor account
#      behind it -- every chat-completion call here spends real Cursor
#      agent-run cost. Only use this against an instance you (or the user)
#      already started and authorized hitting.
#   2. Default: spawn a throwaway instance in "passthrough" auth mode (no
#      CURSOR_API_KEY needed) on an ephemeral port, run structural checks
#      only (health, auth errors, 501s, and the clean upstream-auth error
#      at the Cursor SDK boundary), then tear it down. This is the mode a
#      fresh container with no Cursor credentials should use.
#
# Usage:
#   .claude/skills/run-cursor-openai-proxy/smoke.sh              # spawn + structural checks
#   .claude/skills/run-cursor-openai-proxy/smoke.sh --live       # drive http://127.0.0.1:11434
#   BASE_URL=http://127.0.0.1:9000 ./smoke.sh --live             # drive a different live instance
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$ROOT"

LIVE=0
for arg in "$@"; do
  [ "$arg" = "--live" ] && LIVE=1
done
[ "${USE_LIVE:-0}" = "1" ] && LIVE=1

PASS=0
FAIL=0

check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "OK   $desc (got $actual)"
    PASS=$((PASS + 1))
  else
    echo "FAIL $desc (expected $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

check_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "OK   $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL $desc"
    FAIL=$((FAIL + 1))
  fi
}

if [ "$LIVE" = "1" ]; then
  BASE="${BASE_URL:-http://127.0.0.1:11434}"
  echo "== driving live instance at $BASE (real Cursor calls; costs real agent-run time) =="

  status=$(curl -sS -o /tmp/smoke-health.json -w '%{http_code}' "$BASE/health")
  check "/health" 200 "$status"
  cat /tmp/smoke-health.json
  echo

  BODY=$(curl -sS -o /tmp/smoke-chat.json -w '%{http_code}' "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer skill-smoke-test" -H "Content-Type: application/json" \
    -d '{"model":"auto","messages":[{"role":"user","content":"Reply with exactly the word: pong"}]}')
  check "POST /v1/chat/completions (non-stream)" 200 "$BODY"
  cat /tmp/smoke-chat.json
  echo
  check_contains "model replied 'pong'" "$(cat /tmp/smoke-chat.json)" '"content":"pong"'

  STREAM=$(curl -sSN "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer skill-smoke-test" -H "Content-Type: application/json" \
    -d '{"model":"auto","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"Reply with exactly the word: pong"}]}')
  check_contains "streaming usage chunk present (stream_options.include_usage)" "$STREAM" '"choices":\[\],"usage"'
  check_contains "stream terminated with [DONE]" "$(echo "$STREAM" | tail -1)" '\[DONE\]'

  rm -f /tmp/smoke-health.json /tmp/smoke-chat.json
else
  echo "== spawning a throwaway passthrough-mode instance (no Cursor credentials needed) =="
  WORKDIR=$(mktemp -d /tmp/cursor-proxy-smoke-XXXXXX)
  LOG="$WORKDIR/server.log"
  cleanup() {
    [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
    rm -rf "$WORKDIR"
  }
  trap cleanup EXIT

  if [ ! -d node_modules ]; then
    echo "installing dependencies..."
    npm install
  fi

  node node_modules/tsx/dist/cli.mjs src/index.ts --port 0 --host 127.0.0.1 --workspace "$WORKDIR" >"$LOG" 2>&1 &
  SERVER_PID=$!

  BASE=""
  for _ in $(seq 1 50); do
    if grep -qE 'listening on (http://\S+)' "$LOG" 2>/dev/null; then
      BASE=$(grep -oE 'http://[^ ]+' "$LOG" | head -1)
      break
    fi
    kill -0 "$SERVER_PID" 2>/dev/null || { echo "server exited early:"; cat "$LOG"; exit 1; }
    sleep 0.2
  done
  [ -n "$BASE" ] || { echo "server never logged a listen address:"; cat "$LOG"; exit 1; }
  echo "server listening at $BASE (pid $SERVER_PID)"

  status=$(curl -sS -o /tmp/smoke-health.json -w '%{http_code}' "$BASE/health")
  check "/health" 200 "$status"

  status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
    -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"hi"}]}')
  check "POST /v1/chat/completions with no Authorization header -> 401" 401 "$status"

  status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/completions" \
    -H "Authorization: Bearer test-token-123" -H "Content-Type: application/json" -d '{"prompt":"hi"}')
  check "POST /v1/completions (unimplemented) -> 501" 501 "$status"

  status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/embeddings" \
    -H "Authorization: Bearer test-token-123" -H "Content-Type: application/json" -d '{"input":"hi"}')
  check "POST /v1/embeddings (unimplemented) -> 501" 501 "$status"

  # No CURSOR_API_KEY is configured for this throwaway instance, so any call
  # that reaches the real @cursor/sdk (listModels, createAgent) should fail
  # cleanly with an upstream-auth error mapped to 500 -- not crash the proxy.
  BODY=$(curl -sS -o /tmp/smoke-models.json -w '%{http_code}' "$BASE/v1/models" \
    -H "Authorization: Bearer test-token-123")
  check "GET /v1/models with a fake token -> 500 (clean upstream auth error)" 500 "$BODY"
  check_contains "error body is well-formed" "$(cat /tmp/smoke-models.json)" '"type":"internal_error"'
  rm -f /tmp/smoke-models.json /tmp/smoke-health.json
fi

echo
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
