#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
recover_script="$repo_root/scripts/deploy/recover_release.sh"
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
mkdir -p "$test_root/bin" "$test_root/runner/ssh"
: >"$test_root/runner/ssh/config"

cat >"$test_root/bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
command_line=${*: -1}
if [[ -n "${FAKE_SSH_LOG:-}" ]]; then
  printf '%s\n' "$command_line" >>"$FAKE_SSH_LOG"
fi
if [[ "$command_line" == *'if test -e '* ]]; then
  case "${FAKE_PENDING_STATE:-absent}" in
    absent) printf 'absent' ;;
    present) printf 'present' ;;
    transport-failure) exit 255 ;;
  esac
elif [[ "$command_line" == *'cat '*'/pending-owner'* ]]; then
  printf '%s\n' "${FAKE_PENDING_OWNER:-${TRANSACTION_OWNER:?}}"
elif [[ "$command_line" == *'--record-interruption'* ]]; then
  exit "${FAKE_INTERRUPTION_STATUS:-130}"
elif [[ "$command_line" == *'--rollback-target-image'* ]]; then
  :
elif [[ "$command_line" == *'--finalize-rollback'* ]]; then
  exit "${FAKE_FINALIZE_STATUS:-0}"
elif [[ "$command_line" == *'--record-failed-rollback'* ]]; then
  : >"${FAKE_FAILED_RECORD:?}"
fi
EOF
cat >"$test_root/bin/curl" <<'EOF'
#!/usr/bin/env sh
exit 0
EOF
cat >"$test_root/bin/python3" <<'EOF'
#!/usr/bin/env sh
exit 0
EOF
chmod 0755 "$test_root/bin/ssh" "$test_root/bin/curl" "$test_root/bin/python3"

export ECS_EDGE_BIND_IP=127.0.0.1
export ECS_HOST=203.0.113.10
export ECS_SHARED_INGRESS_HEALTH_PATH=/existing/readyz
IMAGE_REF="ghcr.io/lrm-teams/coforge-realtime-gateway@sha256:$(printf '1%.0s' {1..64})"
export IMAGE_REF
export TRANSACTION_OWNER=test-owner
export RUNNER_TEMP="$test_root/runner"

PATH="$test_root/bin:$PATH" FAKE_PENDING_STATE=absent "$recover_script"
if PATH="$test_root/bin:$PATH" FAKE_PENDING_STATE=transport-failure \
  "$recover_script"; then
  printf 'recovery treated SSH transport failure as an absent transaction\n' >&2
  exit 1
fi

if PATH="$test_root/bin:$PATH" \
  FAKE_PENDING_STATE=present \
  FAKE_INTERRUPTION_STATUS=255 \
  FAKE_FAILED_RECORD="$test_root/unexpected-failed-record" \
  "$recover_script"; then
  printf 'recovery swallowed an interrupted-audit transport failure\n' >&2
  exit 1
fi
if [[ -e "$test_root/unexpected-failed-record" ]]; then
  printf 'recovery mutated state after interrupted-audit failure\n' >&2
  exit 1
fi

recovery_log="$test_root/recovery-order.log"
PATH="$test_root/bin:$PATH" \
  FAKE_PENDING_STATE=present FAKE_PENDING_OWNER=old-run-owner \
  FAKE_SSH_LOG="$recovery_log" "$recover_script"
adopt_line=$(grep -n -- '--adopt-interrupted' "$recovery_log" | cut -d: -f1)
audit_line=$(grep -n -- '--record-interruption' "$recovery_log" | cut -d: -f1)
rollback_line=$(grep -n -- 'compose_release.sh --rollback$' "$recovery_log" | cut -d: -f1)
finalize_line=$(grep -n -- '--finalize-rollback' "$recovery_log" | cut -d: -f1)
if [[ -z "$adopt_line" || -z "$audit_line" || -z "$rollback_line" \
  || -z "$finalize_line" ]] \
  || ((adopt_line >= audit_line || audit_line >= rollback_line \
    || rollback_line >= finalize_line)); then
  printf 'successor recovery did not adopt, audit, rollback, and finalize in order\n' >&2
  exit 1
fi

failed_record="$test_root/failed-record"
if PATH="$test_root/bin:$PATH" \
  FAKE_PENDING_STATE=present \
  FAKE_FINALIZE_STATUS=42 \
  FAKE_FAILED_RECORD="$failed_record" \
  "$recover_script"; then
  printf 'recovery accepted a failed rollback finalization\n' >&2
  exit 1
fi
if [[ ! -e "$failed_record" ]]; then
  printf 'failed rollback finalization was not durably recorded\n' >&2
  exit 1
fi

printf 'release recovery tests passed\n'
