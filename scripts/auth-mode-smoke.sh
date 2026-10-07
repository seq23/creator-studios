#!/usr/bin/env bash
# Deploy smoke for the login mode: `auth-mode-smoke.sh <base url> open|code`.
#   open → GET /api/me with no cookie is 200 (the owner) and POST /api/auth/request is 404.
#   code → GET /api/me with no cookie is 401 and POST /api/auth/request answers (400 for an
#          empty body, so no email is sent).
# Reads up to ~40 s, because the edge can serve the previous version for a few seconds.
set -euo pipefail
BASE="$1"
MODE="$2"
case "$MODE" in
  open) want_me=200 want_req=404 ;;
  code) want_me=401 want_req=400 ;;
  *) echo "auth-mode-smoke: mode must be open or code (got $MODE)"; exit 2 ;;
esac
me="" req=""
for i in 1 2 3 4 5 6 7 8; do
  me="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/me" || true)"
  req="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "$BASE/api/auth/request" || true)"
  [ "$me" = "$want_me" ] && [ "$req" = "$want_req" ] && break
  sleep 5
done
echo "auth mode $MODE: /api/me $me (want $want_me), /api/auth/request $req (want $want_req)"
if [ "$me" != "$want_me" ] || [ "$req" != "$want_req" ]; then
  echo "the deployed Worker is not in $MODE mode"
  exit 1
fi
