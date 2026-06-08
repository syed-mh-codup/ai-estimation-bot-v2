#!/usr/bin/env bash
# WS28-04: post-deploy smoke. Runs against ANY instance URL.
#   ./scripts/smoke.sh https://your-deployment.example.com
# Checks the public surface that needs no credentials. Auth + a real estimate run
# (which needs OpenRouter credits) are exercised manually / by the e2e suite.
set -euo pipefail

BASE_URL="${1:-${BASE_URL:-http://localhost:3000}}"
echo "Smoke testing: $BASE_URL"
fail=0

check() {
  local name="$1" url="$2" expect="$3"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url" || echo "000")
  if [ "$code" = "$expect" ]; then
    echo "  ✓ $name ($code)"
  else
    echo "  ✗ $name (got $code, want $expect)"
    fail=1
  fi
}

# /api/health → 200 ok (DB up + required env present), else 503.
echo "[health]"
health=$(curl -s --max-time 20 "$BASE_URL/api/health" || echo '{}')
echo "  $health"
echo "$health" | grep -q '"status":"ok"' && echo "  ✓ health ok" || { echo "  ✗ health not ok"; fail=1; }

echo "[public routes]"
check "login page" "$BASE_URL/login" 200
check "protected redirect" "$BASE_URL/dashboard" 307

if [ "$fail" = "0" ]; then
  echo "SMOKE PASSED"
else
  echo "SMOKE FAILED"; exit 1
fi
