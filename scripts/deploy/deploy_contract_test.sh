#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
workflow="$repo_root/.github/workflows/deploy-ecs.yml"
ci_workflow="$repo_root/.github/workflows/ci.yml"
container_test="$repo_root/scripts/deploy/container_test.sh"
wss_smoke="$repo_root/scripts/deploy/wss_smoke.py"
tcp_closed="$repo_root/scripts/deploy/tcp_closed.py"
recover_release="$repo_root/scripts/deploy/recover_release.sh"

# shellcheck disable=SC2016
grep -Fq 'docker compose --project-name "$project" --file "$compose_file" config --quiet' \
  "$container_test"
test -x "$wss_smoke"
test -x "$tcp_closed"
test -x "$recover_release"
grep -Fq 'python3 scripts/deploy/wss_smoke.py' "$workflow"
# shellcheck disable=SC2016
grep -Fq 'python3 scripts/deploy/tcp_closed.py "$ECS_HOST" 80' "$workflow"
grep -Fq 'pending-image' "$recover_release"
grep -Fq 'pending-owner' "$recover_release"
grep -Fq 'ps --all --quiet' "$workflow"
grep -Fq 'bootstrap rollback left containers in the Compose project' "$workflow"
grep -Fq 'if commit_release || commit_is_durable; then' "$workflow"
grep -Fq 'release commit failed without durable confirmation; retrying once' "$workflow"
grep -Fq 'compose_release.sh --commit-status' "$workflow"
grep -Fq 'Recover prior interrupted release before deployment' "$workflow"
grep -Fq 'run: scripts/deploy/recover_release.sh' "$workflow"
# shellcheck disable=SC2016
grep -Fq 'if test -e $pending_root/pending-image; then printf present; else printf absent; fi' \
  "$recover_release"
# shellcheck disable=SC2016
grep -Fq '&& ssh -F "$ssh_config" coforge-ecs' "$recover_release"
grep -Fq -- '--record-failed-rollback' "$recover_release"
grep -Fq 'not address.is_global' "$workflow"
grep -Fq 'address.is_multicast' "$workflow"
login_line=$(grep -n 'name: Log deployment user in to GHCR' "$workflow" | cut -d: -f1)
recovery_line=$(grep -n 'name: Recover prior interrupted release before deployment' \
  "$workflow" | cut -d: -f1)
if ((login_line >= recovery_line)); then
  printf 'successor recovery runs before private-registry authentication\n' >&2
  exit 1
fi
evidence_block=$(sed -n '/name: Collect durable release evidence/,/name: Remove remote staging files/p' \
  "$workflow")
if [[ "$evidence_block" == *'continue-on-error: true'* ]] \
  || [[ "$evidence_block" != *'if-no-files-found: error'* ]]; then
  printf 'durable deployment evidence is configured as best-effort\n' >&2
  exit 1
fi
grep -Fq 'mise run test:deploy' "$ci_workflow"
grep -Fq 'mise run check:deploy' "$ci_workflow"

python3 - "$tcp_closed" <<'PY'
import errno
import importlib.util
import socket
import subprocess
import sys
from unittest import mock

listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen()
listener.settimeout(2)
result = subprocess.run(
    [sys.executable, sys.argv[1], "127.0.0.1", str(listener.getsockname()[1]), "--timeout", "1"],
    check=False,
)
connection, _ = listener.accept()
connection.close()
listener.close()
if result.returncode == 0:
    raise SystemExit("TCP closed probe accepted an open listener")

spec = importlib.util.spec_from_file_location("tcp_closed", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with mock.patch.object(socket, "create_connection", side_effect=OSError(errno.EMFILE, "too many files")):
    with mock.patch.object(sys, "argv", ["tcp_closed", "127.0.0.1", "80"]):
        try:
            module.main()
        except OSError as error:
            if error.errno != errno.EMFILE:
                raise
        else:
            raise SystemExit("TCP closed probe treated a local resource error as closed")
PY

printf 'deployment workflow contract tests passed\n'
