#!/usr/bin/env bash
# Deploys the edge functions through the Supabase Management API (no Docker/CLI needed).
# Needs SUPABASE_ACCESS_TOKEN in the environment. Usage: scripts/deploy-functions.sh [telegram|api ...]
set -euo pipefail
REF="${SUPABASE_PROJECT_REF:-fbubzqbqpslpyqoarvcm}"
cd "$(dirname "$0")/../supabase/functions"
for fn in "${@:-telegram api}"; do
  for name in $fn; do
    args=(-F "metadata={\"name\":\"$name\",\"entrypoint_path\":\"$name/index.ts\",\"verify_jwt\":false};type=application/json")
    for f in "$name"/*.ts _shared/*.ts; do args+=(-F "file=@$f;filename=$f;type=application/typescript"); done
    printf '%s: ' "$name"
    curl -sS --fail-with-body -X POST "https://api.supabase.com/v1/projects/$REF/functions/deploy?slug=$name" \
      -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" "${args[@]}" | head -c 300
    echo
  done
done
