#!/usr/bin/env bash
set -euo pipefail

url=${1:?web URL required}
slug=${2:?workspace slug required}
deadline=$((SECONDS + ${COFORGE_E2E_ONLINE_TIMEOUT_SECONDS:-30}))
while (( SECONDS < deadline )); do
  if curl --fail --silent --show-error "$url/computers" \
    | grep -Eqi 'Online'; then
    echo "Online: workspace=$slug"
    exit 0
  fi
  sleep 1
done
echo "Timed out waiting for Online: workspace=$slug" >&2
exit 1
