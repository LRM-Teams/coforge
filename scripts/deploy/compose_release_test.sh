#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
release_script="$repo_root/scripts/deploy/compose_release.sh"
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
export COFORGE_INTERNAL_TEST_MODE=compose-release-tests
export COFORGE_TRANSACTION_OWNER=test-owner
export COFORGE_TCP80_RESULT=passed

mkdir -p "$test_root/bin" "$test_root/app"
printf 'release: first\n' >"$test_root/app/compose.yaml"

cat >"$test_root/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == info ]] && [[ "${FAKE_DOCKER_UNAVAILABLE:-false}" == true ]]; then
  exit 125
fi
if [[ "$*" == 'info --format {{json .SecurityOptions}}' ]]; then
  if [[ -n "${FAKE_EXPECTED_DOCKER_HOST:-}" ]] \
    && [[ "${DOCKER_HOST:-}" != "$FAKE_EXPECTED_DOCKER_HOST" ]]; then
    exit 2
  fi
  if [[ "${FAKE_ROOTLESS_DOCKER:-true}" == true ]]; then
    printf '["name=rootless"]\n'
  else
    printf '[]\n'
  fi
  exit 0
fi
if [[ "$1" == info ]]; then
  exit 0
fi
fake_container_state="$COFORGE_APP_ROOT/.fake-container"
printf '%s %s\n' "$COFORGE_GATEWAY_IMAGE" "$*" >>"$FAKE_DOCKER_LOG"
if [[ "$*" == *" config --quiet"* ]] \
  && [[ "${FAKE_CONFIG_FAIL:-false}" == true ]]; then
  exit 15
fi
if [[ "$*" == *" ps --all --quiet"* ]] \
  && { [[ "${FAKE_EXISTING_CONTAINER:-false}" == true ]] \
    || [[ -e "$fake_container_state" ]]; }; then
  printf 'gateway-container-id\n'
  exit 0
fi
if [[ "$*" == *" ps --quiet gateway"* ]] \
  && [[ -e "$fake_container_state" ]]; then
  printf 'gateway-container-id\n'
  exit 0
fi
if [[ "$1" == inspect ]]; then
  if [[ "$COFORGE_GATEWAY_IMAGE" == "${FAKE_RUNNING_IMAGE_OVERRIDE_FOR:-}" ]]; then
    printf '%s\n' "$FAKE_RUNNING_IMAGE_OVERRIDE"
  else
    printf '%s\n' "$COFORGE_GATEWAY_IMAGE"
  fi
  exit 0
fi
if [[ "$*" == *" up "* ]] \
  && [[ "$COFORGE_GATEWAY_IMAGE" == "${FAKE_COMPOSE_FAIL_IMAGE:-}" ]]; then
  exit 1
fi
if [[ "$*" == *" up "* ]]; then
  : >"$fake_container_state"
fi
if [[ "$*" == *" down"* ]]; then
  if [[ "${FAKE_DOWN_FAIL:-false}" == true ]]; then
    exit 16
  fi
  rm -f -- "$fake_container_state"
fi
EOF
chmod 0755 "$test_root/bin/docker"

cat >"$test_root/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${COFORGE_GATEWAY_IMAGE:-}" == "${FAKE_HEALTH_FAIL_IMAGE:-}" ]]; then
  exit 22
fi
EOF
chmod 0755 "$test_root/bin/curl"

cat >"$test_root/bin/cp" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
destination=${!#}
if [[ "${FAKE_CP_SIGNAL_DURING_PREPARE:-false}" == true ]] \
  && { [[ "$destination" == */pending-previous-compose.yaml ]] \
    || [[ "$destination" == */.compose.before-rollback ]]; }; then
  kill -TERM "$PPID"
  kill -TERM "$$"
fi
if [[ "${FAKE_CP_KILL_DURING_PREPARE:-false}" == true ]] \
  && [[ "$destination" == */pending-previous-compose.yaml ]]; then
  kill -KILL "$PPID"
  kill -KILL "$$"
fi
exec /bin/cp "$@"
EOF
chmod 0755 "$test_root/bin/cp"

cat >"$test_root/bin/mv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source_path=${@: -2:1}
destination=${!#}
if [[ "${FAKE_SENTINEL_PROMOTION_FAIL:-false}" == true ]] \
  && [[ "$source_path" == */.pre-marker-active ]] \
  && [[ "$destination" == */pending-audit-write-failed ]]; then
  exit 17
fi
if [[ "${FAKE_OWNER_PROMOTION_FAIL:-false}" == true ]] \
  && [[ "$source_path" == */.pending-owner.next ]] \
  && [[ "$destination" == */pending-owner ]]; then
  exit 18
fi
/bin/mv "$@"
if [[ "${FAKE_SIGNAL_AFTER_PENDING_MARKER:-false}" == true ]] \
  && [[ "$destination" == */pending-image ]]; then
  kill -TERM "$PPID"
fi
EOF
chmod 0755 "$test_root/bin/mv"

registry=ghcr.io/lrm-teams/coforge-realtime-gateway
first_image="$registry@sha256:$(printf '1%.0s' {1..64})"
second_image="$registry@sha256:$(printf '2%.0s' {1..64})"
third_image="$registry@sha256:$(printf '3%.0s' {1..64})"
fourth_image="$registry@sha256:$(printf '4%.0s' {1..64})"
docker_log="$test_root/docker.log"
source_commit=$(printf 'a%.0s' {1..40})
workflow_run=https://github.com/LRM-Teams/coforge/actions/runs/12345

mkdir -p "$test_root/manual-pre-marker-cancel"
printf 'release: current\n' >"$test_root/manual-pre-marker-cancel/compose.yaml"
printf 'release: previous\n' >"$test_root/manual-pre-marker-cancel/previous-compose.yaml"
printf '%s\n' "$first_image" >"$test_root/manual-pre-marker-cancel/current-image"
printf '%s\n' "$third_image" >"$test_root/manual-pre-marker-cancel/previous-image"
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  FAKE_CP_SIGNAL_DURING_PREPARE=true \
  COFORGE_APP_ROOT="$test_root/manual-pre-marker-cancel" \
  "$release_script" --rollback; then
  printf 'manual pre-marker cancellation returned success unexpectedly\n' >&2
  exit 1
fi
if [[ -e "$test_root/manual-pre-marker-cancel/pending-image" ]] \
  || [[ -e "$test_root/manual-pre-marker-cancel/pending-origin" ]] \
  || [[ -e "$test_root/manual-pre-marker-cancel/.compose.before-rollback" ]] \
  || ! tail -n 1 "$test_root/manual-pre-marker-cancel/release-history.jsonl" \
    | grep -Fq '"source_commit":"manual"' \
  || ! tail -n 1 "$test_root/manual-pre-marker-cancel/release-history.jsonl" \
    | grep -Fq '"outcome":"interrupted"'; then
  printf 'manual pre-marker cancellation was not durably recoverable\n' >&2
  exit 1
fi

mkdir -p "$test_root/pre-marker-audit-failure"
printf 'release: current\n' >"$test_root/pre-marker-audit-failure/compose.yaml"
printf 'release: candidate\n' >"$test_root/pre-marker-audit-failure/candidate.yaml"
printf '%s\n' "$first_image" >"$test_root/pre-marker-audit-failure/current-image"
mkdir "$test_root/pre-marker-audit-failure/release-history.jsonl"
set +e
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  FAKE_CP_SIGNAL_DURING_PREPARE=true \
  COFORGE_APP_ROOT="$test_root/pre-marker-audit-failure" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/pre-marker-audit-failure/candidate.yaml" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$second_image"
audit_failure_status=$?
set -e
if [[ "$audit_failure_status" -ne 74 ]] \
  || [[ ! -e "$test_root/pre-marker-audit-failure/pending-audit-write-failed" ]] \
  || [[ ! -e "$test_root/pre-marker-audit-failure/pending-previous-image" ]] \
  || [[ -e "$test_root/pre-marker-audit-failure/pending-image" ]]; then
  printf 'pre-marker audit failure did not retain fail-closed recovery evidence\n' >&2
  exit 1
fi
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/pre-marker-audit-failure" \
  "$release_script" --current-image >/dev/null 2>&1; then
  printf 'successor ignored a failed pre-marker audit\n' >&2
  exit 1
fi
if [[ ! -e "$test_root/pre-marker-audit-failure/pending-audit-write-failed" ]] \
  || [[ ! -e "$test_root/pre-marker-audit-failure/pending-previous-image" ]]; then
  printf 'successor destroyed failed pre-marker audit evidence\n' >&2
  exit 1
fi

mkdir -p "$test_root/dual-marker-audit-failure"
printf 'release: current\n' >"$test_root/dual-marker-audit-failure/compose.yaml"
printf 'release: candidate\n' >"$test_root/dual-marker-audit-failure/candidate.yaml"
printf '%s\n' "$first_image" >"$test_root/dual-marker-audit-failure/current-image"
mkdir "$test_root/dual-marker-audit-failure/release-history.jsonl"
set +e
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  FAKE_SIGNAL_AFTER_PENDING_MARKER=true \
  COFORGE_APP_ROOT="$test_root/dual-marker-audit-failure" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/dual-marker-audit-failure/candidate.yaml" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$second_image"
dual_marker_status=$?
set -e
if [[ "$dual_marker_status" -ne 74 ]] \
  || [[ ! -e "$test_root/dual-marker-audit-failure/pending-image" ]] \
  || [[ ! -e "$test_root/dual-marker-audit-failure/pending-audit-write-failed" ]]; then
  printf 'dual marker audit failure was not retained\n' >&2
  exit 1
fi
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/dual-marker-audit-failure" \
  "$release_script" --current-image >/dev/null 2>&1; then
  printf 'successor bypassed a dual marker audit failure\n' >&2
  exit 1
fi

mkdir -p "$test_root/hard-loss-active-sentinel"
printf 'release: current\n' >"$test_root/hard-loss-active-sentinel/compose.yaml"
printf 'release: candidate\n' >"$test_root/hard-loss-active-sentinel/candidate.yaml"
printf '%s\n' "$first_image" >"$test_root/hard-loss-active-sentinel/current-image"
set +e
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  FAKE_CP_KILL_DURING_PREPARE=true \
  COFORGE_APP_ROOT="$test_root/hard-loss-active-sentinel" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/hard-loss-active-sentinel/candidate.yaml" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$second_image"
hard_loss_status=$?
set -e
if [[ "$hard_loss_status" -ne 137 ]] \
  || [[ ! -e "$test_root/hard-loss-active-sentinel/.pre-marker-active" ]] \
  || [[ ! -e "$test_root/hard-loss-active-sentinel/pending-previous-image" ]]; then
  printf 'hard loss did not retain active staging evidence\n' >&2
  exit 1
fi
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/hard-loss-active-sentinel" \
  "$release_script" --current-image >/dev/null 2>&1; then
  printf 'successor cleared an active hard-loss sentinel\n' >&2
  exit 1
fi
cp -a "$test_root/hard-loss-active-sentinel" \
  "$test_root/hard-loss-active-failed-rollback"
set +e
PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TRANSACTION_OWNER=test-owner \
  COFORGE_APP_ROOT="$test_root/hard-loss-active-sentinel" \
  "$release_script" --record-interruption
active_only_interruption_status=$?
PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TRANSACTION_OWNER=test-owner \
  COFORGE_APP_ROOT="$test_root/hard-loss-active-failed-rollback" \
  "$release_script" --record-failed-rollback
active_only_failed_rollback_status=$?
set -e
if [[ "$active_only_interruption_status" -ne 74 ]] \
  || [[ ! -e "$test_root/hard-loss-active-sentinel/.pre-marker-active" ]] \
  || [[ -e "$test_root/hard-loss-active-sentinel/pending-failure-stage" ]] \
  || [[ -e "$test_root/hard-loss-active-sentinel/release-history.jsonl" ]]; then
  printf 'interruption audit discarded active-only hard-loss evidence\n' >&2
  exit 1
fi
if [[ "$active_only_failed_rollback_status" -ne 74 ]] \
  || [[ ! -e "$test_root/hard-loss-active-failed-rollback/.pre-marker-active" ]] \
  || [[ -e "$test_root/hard-loss-active-failed-rollback/pending-failure-stage" ]] \
  || [[ -e "$test_root/hard-loss-active-failed-rollback/release-history.jsonl" ]]; then
  printf 'failed-rollback audit discarded active-only hard-loss evidence\n' >&2
  exit 1
fi
for active_only_root in \
  "$test_root/hard-loss-active-sentinel" \
  "$test_root/hard-loss-active-failed-rollback"; do
  if PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
    COFORGE_APP_ROOT="$active_only_root" \
    "$release_script" --current-image >/dev/null 2>&1 \
    || PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
      COFORGE_APP_ROOT="$active_only_root" \
      COFORGE_CANDIDATE_COMPOSE="$active_only_root/candidate.yaml" \
      COFORGE_DEFER_COMMIT=true COFORGE_SOURCE_COMMIT="$source_commit" \
      COFORGE_WORKFLOW_RUN="$workflow_run" COFORGE_EXECUTOR=github-actions \
      COFORGE_TRANSACTION_OWNER=next-owner COFORGE_HEALTH_ATTEMPTS=1 \
      "$release_script" "$third_image" >/dev/null 2>&1; then
    printf 'successor bypassed active-only hard-loss evidence\n' >&2
    exit 1
  fi
done

mkdir -p "$test_root/promotion-fallback"
printf 'release: current\n' >"$test_root/promotion-fallback/compose.yaml"
printf 'release: candidate\n' >"$test_root/promotion-fallback/candidate.yaml"
printf '%s\n' "$first_image" >"$test_root/promotion-fallback/current-image"
mkdir "$test_root/promotion-fallback/release-history.jsonl"
set +e
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  FAKE_CP_SIGNAL_DURING_PREPARE=true \
  FAKE_SENTINEL_PROMOTION_FAIL=true \
  COFORGE_APP_ROOT="$test_root/promotion-fallback" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/promotion-fallback/candidate.yaml" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$second_image"
promotion_fallback_status=$?
set -e
if [[ "$promotion_fallback_status" -ne 74 ]] \
  || [[ ! -e "$test_root/promotion-fallback/pending-audit-write-failed" ]]; then
  printf 'sentinel promotion fallback did not fail closed\n' >&2
  exit 1
fi

mkdir -p "$test_root/formal-ci-stale-active"
printf 'release: current\n' >"$test_root/formal-ci-stale-active/compose.yaml"
printf 'release: candidate\n' >"$test_root/formal-ci-stale-active/candidate.yaml"
printf '%s\n' "$first_image" >"$test_root/formal-ci-stale-active/current-image"
set +e
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TEST_SIGNAL_DURING_ACTIVE_REMOVAL=true \
  COFORGE_APP_ROOT="$test_root/formal-ci-stale-active" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/formal-ci-stale-active/candidate.yaml" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$second_image"
formal_ci_status=$?
set -e
if [[ "$formal_ci_status" -ne 130 ]] \
  || [[ ! -e "$test_root/formal-ci-stale-active/pending-image" ]] \
  || [[ -e "$test_root/formal-ci-stale-active/.pre-marker-active" ]]; then
  printf 'CI active-removal interruption fixture was not created\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/formal-ci-stale-active" \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" --rollback
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/formal-ci-stale-active" \
  COFORGE_PUBLIC_HEALTH_RESULT=passed \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=passed \
  "$release_script" --finalize-rollback
if [[ -e "$test_root/formal-ci-stale-active/pending-image" ]] \
  || [[ -e "$test_root/formal-ci-stale-active/.pre-marker-active" ]] \
  || ! tail -n 1 "$test_root/formal-ci-stale-active/release-history.jsonl" \
    | grep -Fq '"outcome":"rolled_back"'; then
  printf 'CI stale active sentinel prevented complete recovery\n' >&2
  exit 1
fi

mkdir -p "$test_root/formal-manual-stale-active"
printf 'release: current\n' >"$test_root/formal-manual-stale-active/compose.yaml"
printf 'release: previous\n' >"$test_root/formal-manual-stale-active/previous-compose.yaml"
printf '%s\n' "$first_image" >"$test_root/formal-manual-stale-active/current-image"
printf '%s\n' "$third_image" >"$test_root/formal-manual-stale-active/previous-image"
set +e
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TEST_SIGNAL_DURING_ACTIVE_REMOVAL=true \
  COFORGE_APP_ROOT="$test_root/formal-manual-stale-active" \
  "$release_script" --rollback
formal_manual_status=$?
set -e
if [[ "$formal_manual_status" -ne 130 ]] \
  || [[ ! -e "$test_root/formal-manual-stale-active/pending-image" ]] \
  || [[ -e "$test_root/formal-manual-stale-active/.pre-marker-active" ]]; then
  printf 'manual active-removal interruption fixture was not created\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/formal-manual-stale-active" \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" --rollback
cp -a "$test_root/formal-manual-stale-active" \
  "$test_root/manual-finalize-missing-backup"
cp -a "$test_root/formal-manual-stale-active" \
  "$test_root/manual-finalize-corrupt-backup"
cp -a "$test_root/formal-manual-stale-active" \
  "$test_root/manual-finalize-corrupt-target"
cp -a "$test_root/formal-manual-stale-active" \
  "$test_root/manual-finalize-missing-live"
cp -a "$test_root/formal-manual-stale-active" \
  "$test_root/manual-finalize-corrupt-live"
rm -f "$test_root/manual-finalize-missing-backup/.compose.before-rollback"
printf 'corrupt\n' \
  >>"$test_root/manual-finalize-corrupt-backup/.compose.before-rollback"
printf 'corrupt\n' \
  >>"$test_root/manual-finalize-corrupt-target/pending-previous-compose.yaml"
rm -f "$test_root/manual-finalize-missing-live/compose.yaml"
printf 'tampered-after-health\n' \
  >"$test_root/manual-finalize-corrupt-live/compose.yaml"
for invalid_manual_finalize_root in \
  "$test_root/manual-finalize-missing-backup" \
  "$test_root/manual-finalize-corrupt-backup" \
  "$test_root/manual-finalize-corrupt-target" \
  "$test_root/manual-finalize-missing-live" \
  "$test_root/manual-finalize-corrupt-live"; do
  cp -a "$invalid_manual_finalize_root" "$invalid_manual_finalize_root.expected"
  set +e
  PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
    COFORGE_APP_ROOT="$invalid_manual_finalize_root" \
    COFORGE_PUBLIC_HEALTH_RESULT=passed \
    COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
    COFORGE_WSS_HEALTH_RESULT=passed COFORGE_TCP80_RESULT=passed \
    COFORGE_RUNNING_DIGEST_RESULT=passed \
    "$release_script" --finalize-rollback
  invalid_manual_finalize_status=$?
  set -e
  if [[ "$invalid_manual_finalize_status" -ne 74 ]] \
    || ! diff -r "$invalid_manual_finalize_root.expected" \
      "$invalid_manual_finalize_root" >/dev/null; then
    printf 'manual finalization published invalid rollback backup state\n' >&2
    exit 1
  fi
done
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/formal-manual-stale-active" \
  COFORGE_PUBLIC_HEALTH_RESULT=passed \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=passed \
  "$release_script" --finalize-rollback
if [[ -e "$test_root/formal-manual-stale-active/pending-image" ]] \
  || [[ -e "$test_root/formal-manual-stale-active/.pre-marker-active" ]] \
  || ! tail -n 1 "$test_root/formal-manual-stale-active/release-history.jsonl" \
    | grep -Fq '"outcome":"rolled_back"'; then
  printf 'manual stale active sentinel prevented complete recovery\n' >&2
  exit 1
fi

mkdir -p "$test_root/formal-ci-audit-failure"
printf 'release: current\n' >"$test_root/formal-ci-audit-failure/compose.yaml"
printf 'release: candidate\n' >"$test_root/formal-ci-audit-failure/candidate.yaml"
printf '%s\n' "$first_image" >"$test_root/formal-ci-audit-failure/current-image"
mkdir "$test_root/formal-ci-audit-failure/release-history.jsonl"
set +e
PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TEST_SIGNAL_DURING_ACTIVE_REMOVAL=true \
  COFORGE_APP_ROOT="$test_root/formal-ci-audit-failure" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/formal-ci-audit-failure/candidate.yaml" \
  COFORGE_DEFER_COMMIT=true COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 "$release_script" "$second_image"
formal_ci_audit_status=$?
set -e
if [[ "$formal_ci_audit_status" -ne 74 ]] \
  || [[ ! -e "$test_root/formal-ci-audit-failure/pending-image" ]] \
  || [[ ! -e "$test_root/formal-ci-audit-failure/pending-audit-write-failed" ]] \
  || PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
    COFORGE_APP_ROOT="$test_root/formal-ci-audit-failure" \
    "$release_script" --current-image >/dev/null 2>&1; then
  printf 'formal CI audit failure did not fail closed\n' >&2
  exit 1
fi

mkdir -p "$test_root/formal-manual-audit-failure"
printf 'release: current\n' >"$test_root/formal-manual-audit-failure/compose.yaml"
printf 'release: previous\n' >"$test_root/formal-manual-audit-failure/previous-compose.yaml"
printf '%s\n' "$first_image" >"$test_root/formal-manual-audit-failure/current-image"
printf '%s\n' "$third_image" >"$test_root/formal-manual-audit-failure/previous-image"
mkdir "$test_root/formal-manual-audit-failure/release-history.jsonl"
set +e
PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TEST_SIGNAL_DURING_ACTIVE_REMOVAL=true \
  COFORGE_APP_ROOT="$test_root/formal-manual-audit-failure" \
  "$release_script" --rollback
formal_manual_audit_status=$?
set -e
if [[ "$formal_manual_audit_status" -ne 74 ]] \
  || [[ ! -e "$test_root/formal-manual-audit-failure/pending-image" ]] \
  || [[ ! -e "$test_root/formal-manual-audit-failure/pending-audit-write-failed" ]] \
  || PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
    COFORGE_APP_ROOT="$test_root/formal-manual-audit-failure" \
    "$release_script" --current-image >/dev/null 2>&1; then
  printf 'formal manual audit failure did not fail closed\n' >&2
  exit 1
fi

mkdir -p "$test_root/formal-ci-readonly"
printf 'release: current\n' >"$test_root/formal-ci-readonly/compose.yaml"
printf 'release: candidate\n' >"$test_root/formal-ci-readonly/candidate.yaml"
printf '%s\n' "$first_image" >"$test_root/formal-ci-readonly/current-image"
set +e
PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TEST_SIGNAL_READONLY_DURING_PULL=true \
  COFORGE_APP_ROOT="$test_root/formal-ci-readonly" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/formal-ci-readonly/candidate.yaml" \
  COFORGE_DEFER_COMMIT=true COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 "$release_script" "$second_image"
formal_ci_readonly_status=$?
set -e
chmod 0700 "$test_root/formal-ci-readonly"
if [[ "$formal_ci_readonly_status" -eq 0 ]] \
  || [[ ! -e "$test_root/formal-ci-readonly/pending-image" ]] \
  || [[ ! -e "$test_root/formal-ci-readonly/.pre-marker-active" ]] \
  || PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
    COFORGE_APP_ROOT="$test_root/formal-ci-readonly" \
    "$release_script" --current-image >/dev/null 2>&1; then
  printf 'formal CI readonly failure did not retain active fail-closed evidence\n' >&2
  exit 1
fi
cp -a "$test_root/formal-ci-readonly" "$test_root/formal-missing-compose"
cp -a "$test_root/formal-ci-readonly" "$test_root/formal-corrupt-compose"
cp -a "$test_root/formal-ci-readonly" "$test_root/formal-state-mismatch"
cp -a "$test_root/formal-ci-readonly" "$test_root/formal-owner-failure"
rm -f "$test_root/formal-missing-compose/pending-previous-compose.yaml"
printf 'corrupt\n' >>"$test_root/formal-corrupt-compose/pending-previous-compose.yaml"
state_digest=$(<"$test_root/formal-state-mismatch/pending-previous-compose.digest")
mkdir -p "$test_root/formal-state-mismatch/compose-generations"
cp "$test_root/formal-state-mismatch/pending-previous-compose.yaml" \
  "$test_root/formal-state-mismatch/compose-generations/$state_digest.yaml"
printf '%s\nbootstrap:empty\n%s\nnone\n' "$third_image" "$state_digest" \
  >"$test_root/formal-state-mismatch/release-state"
for invalid_formal_root in \
  "$test_root/formal-missing-compose" \
  "$test_root/formal-corrupt-compose" \
  "$test_root/formal-state-mismatch"; do
  set +e
  PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
    COFORGE_TRANSACTION_OWNER=successor-owner \
    COFORGE_APP_ROOT="$invalid_formal_root" \
    "$release_script" --adopt-interrupted
  invalid_formal_status=$?
  set -e
  if [[ "$invalid_formal_status" -ne 74 ]] \
    || [[ "$(<"$invalid_formal_root/pending-owner")" != test-owner ]] \
    || [[ ! -e "$invalid_formal_root/.pre-marker-active" ]] \
    || [[ -e "$invalid_formal_root/pending-failure-stage" ]] \
    || [[ -e "$invalid_formal_root/release-history.jsonl" ]]; then
    printf 'invalid rollback-critical evidence crossed the active gate\n' >&2
    exit 1
  fi
done
mkdir -p "$test_root/formal-prior-pair"
printf 'release: current\n' >"$test_root/formal-prior-pair/compose.yaml"
printf 'release: previous\n' >"$test_root/formal-prior-pair/previous-compose.yaml"
printf 'release: candidate\n' >"$test_root/formal-prior-pair/candidate.yaml"
printf '%s\n' "$first_image" >"$test_root/formal-prior-pair/current-image"
printf '%s\n' "$third_image" >"$test_root/formal-prior-pair/previous-image"
set +e
PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TEST_SIGNAL_READONLY_DURING_PULL=true \
  COFORGE_APP_ROOT="$test_root/formal-prior-pair" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/formal-prior-pair/candidate.yaml" \
  COFORGE_DEFER_COMMIT=true COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 "$release_script" "$second_image"
formal_prior_status=$?
set -e
chmod 0700 "$test_root/formal-prior-pair"
if [[ "$formal_prior_status" -eq 0 ]] \
  || [[ ! -e "$test_root/formal-prior-pair/pending-prior-previous-compose.yaml" ]] \
  || [[ ! -e "$test_root/formal-prior-pair/pending-prior-previous-compose.digest" ]]; then
  printf 'formal prior rollback pair fixture was not created\n' >&2
  exit 1
fi
cp -a "$test_root/formal-prior-pair" "$test_root/formal-prior-missing"
cp -a "$test_root/formal-prior-pair" "$test_root/formal-prior-corrupt"
rm -f "$test_root/formal-prior-missing/pending-prior-previous-compose.yaml"
printf 'corrupt\n' >>"$test_root/formal-prior-corrupt/pending-prior-previous-compose.yaml"
for invalid_prior_root in \
  "$test_root/formal-prior-missing" \
  "$test_root/formal-prior-corrupt"; do
  set +e
  PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
    COFORGE_TRANSACTION_OWNER=successor-owner \
    COFORGE_APP_ROOT="$invalid_prior_root" \
    "$release_script" --adopt-interrupted
  invalid_prior_status=$?
  set -e
  if [[ "$invalid_prior_status" -ne 74 ]] \
    || [[ "$(<"$invalid_prior_root/pending-owner")" != test-owner ]] \
    || [[ ! -e "$invalid_prior_root/.pre-marker-active" ]]; then
    printf 'invalid prior rollback pair crossed the active gate\n' >&2
    exit 1
  fi
done
cp -a "$test_root/formal-owner-failure" \
  "$test_root/formal-owner-failure.expected"
set +e
PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  FAKE_OWNER_PROMOTION_FAIL=true COFORGE_TRANSACTION_OWNER=successor-owner \
  COFORGE_APP_ROOT="$test_root/formal-owner-failure" \
  "$release_script" --adopt-interrupted
owner_failure_status=$?
set -e
if [[ "$owner_failure_status" -ne 74 ]] \
  || ! diff -r "$test_root/formal-owner-failure.expected" \
    "$test_root/formal-owner-failure" >/dev/null; then
  printf 'failed owner handoff mutated formal transaction evidence\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TRANSACTION_OWNER=successor-owner \
  COFORGE_APP_ROOT="$test_root/formal-ci-readonly" \
  "$release_script" --adopt-interrupted
if [[ "$(<"$test_root/formal-ci-readonly/pending-owner")" != successor-owner ]] \
  || [[ ! -e "$test_root/formal-ci-readonly/.pre-marker-active" ]]; then
  printf 'formal active transaction adoption lost owner or active evidence\n' >&2
  exit 1
fi
if PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TRANSACTION_OWNER=successor-owner \
  COFORGE_APP_ROOT="$test_root/formal-ci-readonly" \
  "$release_script" --adopt-interrupted; then
  printf 'formal transaction accepted adoption by its existing owner\n' >&2
  exit 1
fi
if [[ "$(<"$test_root/formal-ci-readonly/pending-owner")" != successor-owner ]] \
  || [[ ! -e "$test_root/formal-ci-readonly/.pre-marker-active" ]]; then
  printf 'same-owner adoption rejection mutated recovery evidence\n' >&2
  exit 1
fi
set +e
PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TRANSACTION_OWNER=successor-owner \
  COFORGE_APP_ROOT="$test_root/formal-ci-readonly" \
  "$release_script" --record-interruption
formal_adopt_audit_status=$?
set -e
if [[ "$formal_adopt_audit_status" -ne 130 ]] \
  || [[ -e "$test_root/formal-ci-readonly/.pre-marker-active" ]] \
  || ! tail -n 1 "$test_root/formal-ci-readonly/release-history.jsonl" \
    | grep -Fq '"outcome":"interrupted"'; then
  printf 'adopted formal transaction was not durably audited\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TRANSACTION_OWNER=successor-owner \
  COFORGE_APP_ROOT="$test_root/formal-ci-readonly" \
  COFORGE_HEALTH_ATTEMPTS=1 "$release_script" --rollback
PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TRANSACTION_OWNER=successor-owner \
  COFORGE_APP_ROOT="$test_root/formal-ci-readonly" \
  COFORGE_PUBLIC_HEALTH_RESULT=passed \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=passed COFORGE_TCP80_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=passed \
  "$release_script" --finalize-rollback
printf 'release: successor\n' >"$test_root/formal-ci-readonly/successor.yaml"
PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TRANSACTION_OWNER=next-owner \
  COFORGE_APP_ROOT="$test_root/formal-ci-readonly" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/formal-ci-readonly/successor.yaml" \
  COFORGE_DEFER_COMMIT=true COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 "$release_script" "$third_image"
PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TRANSACTION_OWNER=next-owner \
  COFORGE_APP_ROOT="$test_root/formal-ci-readonly" \
  COFORGE_PUBLIC_HEALTH_RESULT=passed \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=passed COFORGE_TCP80_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=passed \
  "$release_script" --commit
if [[ "$(<"$test_root/formal-ci-readonly/current-image")" != "$third_image" ]] \
  || [[ -e "$test_root/formal-ci-readonly/pending-image" ]]; then
  printf 'successor digest did not deploy after adopted recovery\n' >&2
  exit 1
fi

mkdir -p "$test_root/formal-manual-readonly"
printf 'release: current\n' >"$test_root/formal-manual-readonly/compose.yaml"
printf 'release: previous\n' >"$test_root/formal-manual-readonly/previous-compose.yaml"
printf '%s\n' "$first_image" >"$test_root/formal-manual-readonly/current-image"
printf '%s\n' "$third_image" >"$test_root/formal-manual-readonly/previous-image"
set +e
PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TEST_SIGNAL_READONLY_DURING_PULL=true \
  COFORGE_APP_ROOT="$test_root/formal-manual-readonly" \
  "$release_script" --rollback
formal_manual_readonly_status=$?
set -e
chmod 0700 "$test_root/formal-manual-readonly"
if [[ "$formal_manual_readonly_status" -eq 0 ]] \
  || [[ ! -e "$test_root/formal-manual-readonly/pending-image" ]] \
  || [[ ! -e "$test_root/formal-manual-readonly/.pre-marker-active" ]] \
  || PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
    COFORGE_APP_ROOT="$test_root/formal-manual-readonly" \
    "$release_script" --current-image >/dev/null 2>&1; then
  printf 'formal manual readonly failure did not retain active fail-closed evidence\n' >&2
  exit 1
fi
if PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TRANSACTION_OWNER=successor-owner \
  COFORGE_APP_ROOT="$test_root/formal-manual-readonly" \
  "$release_script" --adopt-interrupted; then
  printf 'manual transaction was incorrectly eligible for CI adoption\n' >&2
  exit 1
fi
if [[ "$(<"$test_root/formal-manual-readonly/pending-owner")" != test-owner ]] \
  || [[ ! -e "$test_root/formal-manual-readonly/.pre-marker-active" ]]; then
  printf 'manual adoption rejection mutated recovery evidence\n' >&2
  exit 1
fi

mkdir -p "$test_root/config-validation"
printf 'release: current\n' >"$test_root/config-validation/compose.yaml"
printf 'release: invalid-candidate\n' >"$test_root/config-validation/candidate.yaml"
printf '%s\n' "$first_image" >"$test_root/config-validation/current-image"
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  FAKE_CONFIG_FAIL=true \
  COFORGE_APP_ROOT="$test_root/config-validation" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/config-validation/candidate.yaml" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$second_image"; then
  printf 'expected invalid candidate Compose definition to be rejected\n' >&2
  exit 1
fi
if [[ "$(<"$test_root/config-validation/compose.yaml")" != 'release: current' ]]; then
  printf 'invalid candidate Compose definition mutated the active definition\n' >&2
  exit 1
fi
if ! grep -Fq ' config --quiet' "$docker_log"; then
  printf 'candidate Compose definition was not rendered and validated\n' >&2
  exit 1
fi
if ! grep -Fq '"outcome":"failed_preparation"' \
  "$test_root/config-validation/release-history.jsonl"; then
  printf 'pre-mutation validation failure was not durably audited\n' >&2
  exit 1
fi

mkdir -p "$test_root/nonempty-bootstrap"
printf 'release: candidate\n' >"$test_root/nonempty-bootstrap/compose.yaml"
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  FAKE_EXISTING_CONTAINER=true \
  COFORGE_APP_ROOT="$test_root/nonempty-bootstrap" \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$first_image"; then
  printf 'expected missing release record on a non-empty project to fail\n' >&2
  exit 1
fi
if [[ -e "$test_root/nonempty-bootstrap/current-image" ]]; then
  printf 'non-empty bootstrap was incorrectly recorded as healthy\n' >&2
  exit 1
fi
if ! grep -Fq ' ps --all --quiet' "$docker_log"; then
  printf 'bootstrap did not inspect all Compose project containers\n' >&2
  exit 1
fi

mkdir -p "$test_root/deferred-commit"
printf 'release: current\n' >"$test_root/deferred-commit/compose.yaml"
printf 'release: candidate\n' >"$test_root/deferred-commit/candidate.yaml"
printf '%s\n' "$first_image" >"$test_root/deferred-commit/current-image"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/deferred-commit" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/deferred-commit/candidate.yaml" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$second_image"
if [[ "$(<"$test_root/deferred-commit/current-image")" != "$first_image" ]]; then
  printf 'candidate was committed before external health verification\n' >&2
  exit 1
fi
if [[ "$(<"$test_root/deferred-commit/pending-image")" != "$second_image" ]]; then
  printf 'internally healthy candidate was not recorded as pending\n' >&2
  exit 1
fi
cp -a "$test_root/deferred-commit" "$test_root/commit-missing-compose"
cp -a "$test_root/deferred-commit" "$test_root/commit-corrupt-compose"
cp -a "$test_root/deferred-commit" "$test_root/commit-missing-live"
cp -a "$test_root/deferred-commit" "$test_root/commit-corrupt-live"
cp -a "$test_root/deferred-commit" "$test_root/commit-missing-candidate"
cp -a "$test_root/deferred-commit" "$test_root/commit-corrupt-candidate"
rm -f "$test_root/commit-missing-compose/pending-previous-compose.yaml"
printf 'corrupt\n' >>"$test_root/commit-corrupt-compose/pending-previous-compose.yaml"
rm -f "$test_root/commit-missing-live/compose.yaml"
printf 'tampered-after-health\n' >"$test_root/commit-corrupt-live/compose.yaml"
rm -f "$test_root/commit-missing-candidate/pending-candidate-compose.yaml"
printf 'corrupt\n' \
  >>"$test_root/commit-corrupt-candidate/pending-candidate-compose.yaml"
for invalid_commit_root in \
  "$test_root/commit-missing-compose" \
  "$test_root/commit-corrupt-compose" \
  "$test_root/commit-missing-live" \
  "$test_root/commit-corrupt-live" \
  "$test_root/commit-missing-candidate" \
  "$test_root/commit-corrupt-candidate"; do
  cp -a "$invalid_commit_root" "$invalid_commit_root.expected"
  set +e
  PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
    COFORGE_APP_ROOT="$invalid_commit_root" \
    COFORGE_PUBLIC_HEALTH_RESULT=passed \
    COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
    COFORGE_WSS_HEALTH_RESULT=passed COFORGE_TCP80_RESULT=passed \
    COFORGE_RUNNING_DIGEST_RESULT=passed \
    "$release_script" --commit
  invalid_commit_status=$?
  set -e
  if [[ "$invalid_commit_status" -ne 74 ]] \
    || ! diff -r "$invalid_commit_root.expected" \
      "$invalid_commit_root" >/dev/null; then
    printf 'commit published invalid previous Compose state\n' >&2
    exit 1
  fi
done

mkdir -p "$test_root/orphan-sidecars"
printf 'release: current\n' >"$test_root/orphan-sidecars/compose.yaml"
printf 'release: candidate\n' >"$test_root/orphan-sidecars/candidate.yaml"
printf '%s\n' "$first_image" >"$test_root/orphan-sidecars/current-image"
printf 'manual\n' >"$test_root/orphan-sidecars/pending-origin"
printf 'manual\n' >"$test_root/orphan-sidecars/pending-failure-stage"
printf 'bootstrap:empty\n' >"$test_root/orphan-sidecars/pending-manual-from"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/orphan-sidecars" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/orphan-sidecars/candidate.yaml" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$second_image"
if [[ -e "$test_root/orphan-sidecars/pending-manual-from" ]] \
  || [[ -e "$test_root/orphan-sidecars/pending-failure-stage" ]]; then
  printf 'orphaned manual sidecars contaminated a new CI transaction\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/orphan-sidecars" \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" --rollback
if [[ "$(<"$test_root/orphan-sidecars/pending-failure-stage")" != external ]]; then
  printf 'CI external rollback inherited an orphaned manual trigger\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/orphan-sidecars" \
  COFORGE_PUBLIC_HEALTH_RESULT=passed \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=passed \
  "$release_script" --finalize-rollback
if ! tail -n 1 "$test_root/orphan-sidecars/release-history.jsonl" \
  | grep -Fq 'candidate_external=failed'; then
  printf 'CI external rollback audit retained an orphaned manual trigger\n' >&2
  exit 1
fi

mkdir -p "$test_root/pre-marker-cancel"
printf 'release: current\n' >"$test_root/pre-marker-cancel/compose.yaml"
printf 'release: candidate\n' >"$test_root/pre-marker-cancel/candidate.yaml"
printf '%s\n' "$first_image" >"$test_root/pre-marker-cancel/current-image"
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/pre-marker-cancel" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/pre-marker-cancel/candidate.yaml" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  FAKE_CP_SIGNAL_DURING_PREPARE=true \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$second_image"; then
  printf 'pre-marker cancellation returned success unexpectedly\n' >&2
  exit 1
fi
if [[ -e "$test_root/pre-marker-cancel/pending-image" ]] \
  || [[ -e "$test_root/pre-marker-cancel/pending-previous-image" ]] \
  || ! tail -n 1 "$test_root/pre-marker-cancel/release-history.jsonl" \
    | grep -Fq '"outcome":"interrupted"' \
  || ! tail -n 1 "$test_root/pre-marker-cancel/release-history.jsonl" \
    | grep -Fq '"final_observed_state":"unchanged"'; then
  printf 'pre-marker cancellation was not durably recoverable\n' >&2
  exit 1
fi
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/deferred-commit" \
  "$release_script" --commit; then
  printf 'candidate committed without external health evidence\n' >&2
  exit 1
fi
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/deferred-commit" \
  COFORGE_PUBLIC_HEALTH_RESULT=passed \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=passed \
  "$release_script" --commit; then
  printf 'candidate committed without WSS smoke evidence\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/deferred-commit" \
  COFORGE_PUBLIC_HEALTH_RESULT=passed \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=passed \
  "$release_script" --commit
if [[ "$(<"$test_root/deferred-commit/current-image")" != "$second_image" ]]; then
  printf 'externally verified candidate was not committed\n' >&2
  exit 1
fi
if ! grep -Fq '"outcome":"healthy"' "$test_root/deferred-commit/release-history.jsonl"; then
  printf 'healthy deployment did not create a durable audit record\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/deferred-commit" \
  COFORGE_EXPECTED_IMAGE="$second_image" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  "$release_script" --commit-status
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/deferred-commit" \
  COFORGE_EXPECTED_IMAGE="$second_image" \
  COFORGE_WORKFLOW_RUN=https://github.com/LRM-Teams/coforge/actions/runs/99999 \
  "$release_script" --commit-status; then
  printf 'commit status accepted a mismatched workflow audit record\n' >&2
  exit 1
fi
for required_field in source_commit image_digest environment workflow_run \
  previous_digest health_result executor started_at completed_at outcome; do
  if ! grep -Fq "\"$required_field\"" "$test_root/deferred-commit/release-history.jsonl"; then
    printf 'audit record is missing %s\n' "$required_field" >&2
    exit 1
  fi
done

mkdir -p "$test_root/retry-commit"
printf 'release: current\n' >"$test_root/retry-commit/compose.yaml"
printf 'release: candidate\n' >"$test_root/retry-commit/candidate.yaml"
printf '%s\n' "$first_image" >"$test_root/retry-commit/current-image"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/retry-commit" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/retry-commit/candidate.yaml" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$second_image"
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/retry-commit" \
  COFORGE_PUBLIC_HEALTH_RESULT=passed \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=passed \
  COFORGE_TEST_FAIL_AFTER_COMMIT_AUDIT=true \
  "$release_script" --commit; then
  printf 'expected injected post-audit commit failure\n' >&2
  exit 1
fi
if [[ ! -e "$test_root/retry-commit/pending-image" ]]; then
  printf 'post-audit commit failure discarded retry evidence\n' >&2
  exit 1
fi
cp -a "$test_root/retry-commit" "$test_root/retry-commit-missing-live"
rm -f "$test_root/retry-commit-missing-live/compose.yaml"
cp -a "$test_root/retry-commit-missing-live" \
  "$test_root/retry-commit-missing-live.expected"
set +e
PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/retry-commit-missing-live" \
  COFORGE_PUBLIC_HEALTH_RESULT=passed \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=passed COFORGE_TCP80_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=passed \
  "$release_script" --commit
retry_missing_live_status=$?
set -e
if [[ "$retry_missing_live_status" -ne 74 ]] \
  || ! diff -r "$test_root/retry-commit-missing-live.expected" \
    "$test_root/retry-commit-missing-live" >/dev/null; then
  printf 'partial-pointer retry published a missing live Compose definition\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/retry-commit" \
  COFORGE_PUBLIC_HEALTH_RESULT=passed \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=passed \
  "$release_script" --commit
if [[ -e "$test_root/retry-commit/pending-image" ]] \
  || [[ $(grep -Fc '"outcome":"healthy"' "$test_root/retry-commit/release-history.jsonl") -ne 1 ]]; then
  printf 'commit retry did not reconcile to one durable healthy outcome\n' >&2
  exit 1
fi

mkdir -p "$test_root/generation-repair/compose-generations"
printf 'release: current\n' >"$test_root/generation-repair/compose.yaml"
printf 'release: candidate\n' >"$test_root/generation-repair/candidate.yaml"
printf '%s\n' "$first_image" >"$test_root/generation-repair/current-image"
candidate_compose_hash=$(sha256sum "$test_root/generation-repair/candidate.yaml" | cut -d ' ' -f 1)
printf 'truncated\n' >"$test_root/generation-repair/compose-generations/$candidate_compose_hash.yaml"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/generation-repair" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/generation-repair/candidate.yaml" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$second_image"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/generation-repair" \
  COFORGE_PUBLIC_HEALTH_RESULT=passed \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=passed \
  "$release_script" --commit
if [[ "$(sha256sum "$test_root/generation-repair/compose-generations/$candidate_compose_hash.yaml" | cut -d ' ' -f 1)" != "$candidate_compose_hash" ]]; then
  printf 'Compose generation was not atomically repaired before pointer publication\n' >&2
  exit 1
fi

mkdir -p "$test_root/partial-commit"
printf 'release: previous\n' >"$test_root/partial-commit/previous-compose.yaml"
printf 'release: current\n' >"$test_root/partial-commit/compose.yaml"
printf 'release: candidate\n' >"$test_root/partial-commit/candidate.yaml"
printf '%s\n' "$first_image" >"$test_root/partial-commit/current-image"
printf '%s\n' "$third_image" >"$test_root/partial-commit/previous-image"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/partial-commit" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/partial-commit/candidate.yaml" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$second_image"
mkdir "$test_root/partial-commit/release-history.jsonl"
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/partial-commit" \
  COFORGE_PUBLIC_HEALTH_RESULT=passed \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=passed \
  "$release_script" --commit; then
  printf 'expected commit audit failure after pointer mutation\n' >&2
  exit 1
fi
if [[ "$(<"$test_root/partial-commit/current-image")" != "$second_image" ]] \
  || [[ ! -e "$test_root/partial-commit/pending-image" ]]; then
  printf 'commit failure fixture did not retain its partial transaction\n' >&2
  exit 1
fi
rmdir "$test_root/partial-commit/release-history.jsonl"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/partial-commit" \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" --rollback
if [[ "$(PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/partial-commit" \
  "$release_script" --rollback-target-image)" != "$first_image" ]]; then
  printf 'partial commit workflow selected the candidate instead of rollback target\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/partial-commit" \
  COFORGE_PUBLIC_HEALTH_RESULT=passed \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=passed \
  "$release_script" --finalize-rollback
if [[ "$(<"$test_root/partial-commit/current-image")" != "$first_image" ]] \
  || [[ "$(<"$test_root/partial-commit/previous-image")" != "$third_image" ]] \
  || [[ "$(<"$test_root/partial-commit/compose.yaml")" != 'release: current' ]] \
  || [[ "$(<"$test_root/partial-commit/previous-compose.yaml")" != 'release: previous' ]]; then
  printf 'partial commit rollback did not restore the complete prior release state\n' >&2
  exit 1
fi
if [[ -e "$test_root/partial-commit/pending-image" ]] \
  || ! tail -n 1 "$test_root/partial-commit/release-history.jsonl" \
    | grep -Fq '"outcome":"rolled_back"'; then
  printf 'partial commit rollback did not finalize durable recovery\n' >&2
  exit 1
fi

printf 'release: rejected-candidate\n' >"$test_root/deferred-commit/rejected.yaml"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/deferred-commit" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/deferred-commit/rejected.yaml" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$third_image"
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TRANSACTION_OWNER=other-owner \
  COFORGE_APP_ROOT="$test_root/deferred-commit" \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" --rollback; then
  printf 'expected a different transaction owner to be rejected\n' >&2
  exit 1
fi
printf 'external\n' >"$test_root/deferred-commit/pending-failure-stage"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TRANSACTION_OWNER=other-owner \
  COFORGE_APP_ROOT="$test_root/deferred-commit" \
  "$release_script" --adopt-interrupted
if [[ "$(<"$test_root/deferred-commit/pending-owner")" != other-owner ]] \
  || [[ "$(<"$test_root/deferred-commit/pending-failure-stage")" != external ]]; then
  printf 'a successor workflow could not adopt an external-stage transaction\n' >&2
  exit 1
fi
printf 'internal\n' >"$test_root/deferred-commit/pending-failure-stage"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TRANSACTION_OWNER=test-owner \
  COFORGE_APP_ROOT="$test_root/deferred-commit" \
  "$release_script" --adopt-interrupted
if [[ "$(<"$test_root/deferred-commit/pending-failure-stage")" != internal ]]; then
  printf 'a successor workflow could not adopt an internal-stage transaction\n' >&2
  exit 1
fi
printf 'external\n' >"$test_root/deferred-commit/pending-failure-stage"
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/deferred-commit" \
  "$release_script" --record-interruption; then
  printf 'explicit interruption recorder returned success unexpectedly\n' >&2
  exit 1
fi
if [[ "$(<"$test_root/deferred-commit/pending-failure-stage")" != external ]]; then
  printf 'interruption audit overwrote the original rollback trigger\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/deferred-commit" \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" --rollback
if [[ "$(<"$test_root/deferred-commit/current-image")" != "$second_image" ]]; then
  printf 'pending rollback did not preserve the last externally healthy image\n' >&2
  exit 1
fi
if [[ "$(<"$test_root/deferred-commit/compose.yaml")" != 'release: candidate' ]]; then
  printf 'pending rollback did not restore the last externally healthy Compose definition\n' >&2
  exit 1
fi
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/deferred-commit" \
  "$release_script" --finalize-rollback; then
  printf 'rollback finalized without complete external health evidence\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/deferred-commit" \
  COFORGE_PUBLIC_HEALTH_RESULT=passed \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=passed \
  "$release_script" --finalize-rollback

mkdir -p "$test_root/failed-rollback"
printf 'release: healthy\n' >"$test_root/failed-rollback/compose.yaml"
printf 'release: prior\n' >"$test_root/failed-rollback/previous-compose.yaml"
printf 'release: candidate\n' >"$test_root/failed-rollback/candidate.yaml"
printf '%s\n' "$first_image" >"$test_root/failed-rollback/current-image"
printf '%s\n' "$third_image" >"$test_root/failed-rollback/previous-image"
mkdir -p "$test_root/failed-rollback/compose-generations"
failed_current_compose_digest=$(sha256sum "$test_root/failed-rollback/compose.yaml" | cut -d ' ' -f 1)
failed_previous_compose_digest=$(sha256sum "$test_root/failed-rollback/previous-compose.yaml" | cut -d ' ' -f 1)
cp "$test_root/failed-rollback/compose.yaml" \
  "$test_root/failed-rollback/compose-generations/$failed_current_compose_digest.yaml"
cp "$test_root/failed-rollback/previous-compose.yaml" \
  "$test_root/failed-rollback/compose-generations/$failed_previous_compose_digest.yaml"
printf '%s\n%s\n%s\n%s\n' "$first_image" "$third_image" \
  "$failed_current_compose_digest" "$failed_previous_compose_digest" \
  >"$test_root/failed-rollback/release-state"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/failed-rollback" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/failed-rollback/candidate.yaml" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$second_image"
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  FAKE_HEALTH_FAIL_IMAGE="$first_image" \
  COFORGE_APP_ROOT="$test_root/failed-rollback" \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" --rollback; then
  printf 'expected rollback health failure\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/failed-rollback" \
  "$release_script" --record-failed-rollback
if ! tail -n 1 "$test_root/failed-rollback/release-history.jsonl" \
  | grep -Fq '"outcome":"failed_rollback"'; then
  printf 'failed rollback did not create a durable audit record\n' >&2
  exit 1
fi
if ! tail -n 1 "$test_root/failed-rollback/release-history.jsonl" \
  | grep -Fq '"final_observed_state"'; then
  printf 'failed rollback did not record the final observed state\n' >&2
  exit 1
fi
if ! tail -n 1 "$test_root/failed-rollback/release-history.jsonl" \
  | grep -Fq '"next_rollback_digest":"sha256:3333333333333333333333333333333333333333333333333333333333333333"'; then
  printf 'failed rollback did not retain the next rollback identity\n' >&2
  exit 1
fi

mkdir -p "$test_root/partial-pointer-failed-rollback"
printf 'release: selected\n' >"$test_root/partial-pointer-failed-rollback/compose.yaml"
printf 'release: next\n' >"$test_root/partial-pointer-failed-rollback/previous-compose.yaml"
mkdir -p "$test_root/partial-pointer-failed-rollback/compose-generations"
partial_selected_compose_digest=$(sha256sum "$test_root/partial-pointer-failed-rollback/compose.yaml" | cut -d ' ' -f 1)
partial_next_compose_digest=$(sha256sum "$test_root/partial-pointer-failed-rollback/previous-compose.yaml" | cut -d ' ' -f 1)
cp "$test_root/partial-pointer-failed-rollback/compose.yaml" \
  "$test_root/partial-pointer-failed-rollback/compose-generations/$partial_selected_compose_digest.yaml"
cp "$test_root/partial-pointer-failed-rollback/previous-compose.yaml" \
  "$test_root/partial-pointer-failed-rollback/compose-generations/$partial_next_compose_digest.yaml"
printf '%s\n%s\n%s\n%s\n' "$second_image" "$first_image" \
  "$partial_selected_compose_digest" "$partial_next_compose_digest" \
  >"$test_root/partial-pointer-failed-rollback/release-state"
printf '%s\n' "$second_image" >"$test_root/partial-pointer-failed-rollback/pending-image"
printf '%s\n' "$first_image" >"$test_root/partial-pointer-failed-rollback/pending-previous-image"
printf '%s\n' "$third_image" >"$test_root/partial-pointer-failed-rollback/pending-prior-previous-image"
printf '%s\n' "$source_commit" >"$test_root/partial-pointer-failed-rollback/pending-source-commit"
printf '%s\n' "$workflow_run" >"$test_root/partial-pointer-failed-rollback/pending-workflow-run"
printf 'github-actions\n' >"$test_root/partial-pointer-failed-rollback/pending-executor"
printf '2026-08-26T00:00:00Z\n' >"$test_root/partial-pointer-failed-rollback/pending-started-at"
printf 'release\n' >"$test_root/partial-pointer-failed-rollback/pending-origin"
printf 'test-owner\n' >"$test_root/partial-pointer-failed-rollback/pending-owner"
printf 'external\n' >"$test_root/partial-pointer-failed-rollback/pending-failure-stage"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/partial-pointer-failed-rollback" \
  "$release_script" --record-failed-rollback
if ! tail -n 1 "$test_root/partial-pointer-failed-rollback/release-history.jsonl" \
  | grep -Fq 'selected_image=ghcr.io/lrm-teams/coforge-realtime-gateway@sha256:2222222222222222222222222222222222222222222222222222222222222222' \
  || ! tail -n 1 "$test_root/partial-pointer-failed-rollback/release-history.jsonl" \
    | grep -Fq '"next_rollback_digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"'; then
  printf 'partial pointer failed rollback did not use authoritative identities\n' >&2
  exit 1
fi
if [[ ! -e "$test_root/failed-rollback/pending-image" ]]; then
  printf 'failed rollback discarded recovery evidence\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  FAKE_DOCKER_UNAVAILABLE=true \
  COFORGE_APP_ROOT="$test_root/failed-rollback" \
  "$release_script" --record-failed-rollback
if ! tail -n 1 "$test_root/failed-rollback/release-history.jsonl" \
  | grep -Fq '"final_observed_state":"docker=unavailable;'; then
  printf 'failed rollback could not be audited while Docker was unavailable\n' >&2
  exit 1
fi
if ! tail -n 1 "$test_root/deferred-commit/release-history.jsonl" \
  | grep -Fq '"outcome":"rolled_back"'; then
  printf 'successful rollback did not create a durable audit record\n' >&2
  exit 1
fi
if [[ -e "$test_root/deferred-commit/pending-image" ]]; then
  printf 'successful rollback left a pending release transaction\n' >&2
  exit 1
fi

printf 'release: internal-failure\n' >"$test_root/deferred-commit/internal-failure.yaml"
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  FAKE_HEALTH_FAIL_IMAGE="$fourth_image" \
  COFORGE_APP_ROOT="$test_root/deferred-commit" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/deferred-commit/internal-failure.yaml" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$fourth_image"; then
  printf 'expected internally unhealthy deferred candidate to fail\n' >&2
  exit 1
fi
if [[ "$(<"$test_root/deferred-commit/current-image")" != "$second_image" ]] \
  || [[ "$(<"$test_root/deferred-commit/compose.yaml")" != 'release: candidate' ]]; then
  printf 'internal failure did not restore the last externally healthy release\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/deferred-commit" \
  COFORGE_PUBLIC_HEALTH_RESULT=passed \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=passed \
  "$release_script" --finalize-rollback
if ! tail -n 1 "$test_root/deferred-commit/release-history.jsonl" \
  | grep -Fq 'candidate_internal=failed'; then
  printf 'internal failure audit record did not identify the failed health layer\n' >&2
  exit 1
fi

printf 'release: digest-mismatch\n' >"$test_root/deferred-commit/digest-mismatch.yaml"
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  FAKE_RUNNING_IMAGE_OVERRIDE="$first_image" \
  FAKE_RUNNING_IMAGE_OVERRIDE_FOR="$third_image" \
  COFORGE_APP_ROOT="$test_root/deferred-commit" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/deferred-commit/digest-mismatch.yaml" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$third_image"; then
  printf 'expected running image digest mismatch to fail deployment\n' >&2
  exit 1
fi
if [[ "$(<"$test_root/deferred-commit/current-image")" != "$second_image" ]]; then
  printf 'digest mismatch did not restore the last healthy release\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/deferred-commit" \
  COFORGE_PUBLIC_HEALTH_RESULT=passed \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=passed \
  "$release_script" --finalize-rollback

mkdir -p "$test_root/empty-state-rollback"
printf 'release: first-candidate\n' >"$test_root/empty-state-rollback/candidate.yaml"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/empty-state-rollback" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/empty-state-rollback/candidate.yaml" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$first_image"
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/empty-state-rollback" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$second_image"; then
  printf 'expected a new release to reject an interrupted pending transaction\n' >&2
  exit 1
fi
if ! grep -Fq '"outcome":"interrupted"' \
  "$test_root/empty-state-rollback/release-history.jsonl"; then
  printf 'recovered pending transaction was not durably audited as interrupted\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/empty-state-rollback" \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" --rollback
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/empty-state-rollback" \
  COFORGE_PUBLIC_HEALTH_RESULT=not-applicable \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=not-applicable \
  COFORGE_RUNNING_DIGEST_RESULT=not-applicable \
  "$release_script" --finalize-rollback
if ! tail -n 1 "$test_root/empty-state-rollback/release-history.jsonl" \
  | grep -Fq 'rollback_wss_handshake=not-applicable'; then
  printf 'empty-state rollback did not record explicit non-applicable WSS evidence\n' >&2
  exit 1
fi
if [[ "$(sed -n '1p' "$test_root/empty-state-rollback/release-state")" != bootstrap:empty ]] \
  || [[ "$(sed -n '3p' "$test_root/empty-state-rollback/release-state")" != none ]]; then
  printf 'automatic bootstrap rollback bound empty state to a Compose generation\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/empty-state-rollback" \
  "$release_script" --current-image >/dev/null

mkdir -p "$test_root/empty-state-down-failure"
printf 'release: first-candidate\n' >"$test_root/empty-state-down-failure/candidate.yaml"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/empty-state-down-failure" \
  COFORGE_CANDIDATE_COMPOSE="$test_root/empty-state-down-failure/candidate.yaml" \
  COFORGE_DEFER_COMMIT=true \
  COFORGE_SOURCE_COMMIT="$source_commit" \
  COFORGE_WORKFLOW_RUN="$workflow_run" \
  COFORGE_EXECUTOR=github-actions \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$first_image"
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  FAKE_DOWN_FAIL=true \
  COFORGE_APP_ROOT="$test_root/empty-state-down-failure" \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" --rollback; then
  printf 'expected failed bootstrap shutdown to fail rollback\n' >&2
  exit 1
fi
if [[ -e "$test_root/empty-state-down-failure/pending-rollback-complete" ]]; then
  printf 'failed bootstrap shutdown was marked as a completed rollback\n' >&2
  exit 1
fi

mkdir -p "$test_root/first-deploy"
printf 'release: current-only\n' >"$test_root/first-deploy/compose.yaml"
printf '%s\n' "$first_image" >"$test_root/first-deploy/current-image"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/first-deploy" \
  "$release_script" --rollback
if [[ "$(<"$test_root/first-deploy/current-image")" != "$first_image" ]] \
  || [[ ! -e "$test_root/first-deploy/pending-rollback-complete" ]]; then
  printf 'empty-state rollback changed release records before external verification\n' >&2
  exit 1
fi
if ! tail -n 2 "$docker_log" | grep -Fq ' down'; then
  printf 'rollback without a previous image did not stop the Compose project\n' >&2
  exit 1
fi
cp -a "$test_root/first-deploy" "$test_root/empty-manual-missing-live"
cp -a "$test_root/first-deploy" "$test_root/empty-manual-corrupt-live"
rm -f "$test_root/empty-manual-missing-live/compose.yaml"
printf 'tampered-after-health\n' \
  >"$test_root/empty-manual-corrupt-live/compose.yaml"
for invalid_empty_manual_root in \
  "$test_root/empty-manual-missing-live" \
  "$test_root/empty-manual-corrupt-live"; do
  cp -a "$invalid_empty_manual_root" "$invalid_empty_manual_root.expected"
  set +e
  PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
    COFORGE_APP_ROOT="$invalid_empty_manual_root" \
    COFORGE_PUBLIC_HEALTH_RESULT=not-applicable \
    COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
    COFORGE_WSS_HEALTH_RESULT=not-applicable COFORGE_TCP80_RESULT=passed \
    COFORGE_RUNNING_DIGEST_RESULT=not-applicable \
    "$release_script" --finalize-rollback
  invalid_empty_manual_status=$?
  set -e
  if [[ "$invalid_empty_manual_status" -ne 74 ]] \
    || ! diff -r "$invalid_empty_manual_root.expected" \
      "$invalid_empty_manual_root" >/dev/null; then
    printf 'empty manual finalization published invalid live Compose state\n' >&2
    exit 1
  fi
done
set +e
PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/first-deploy" \
  COFORGE_PUBLIC_HEALTH_RESULT=not-applicable \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=not-applicable COFORGE_TCP80_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=not-applicable \
  COFORGE_TEST_FAIL_AFTER_FINALIZE_STATE=true \
  "$release_script" --finalize-rollback
partial_manual_finalize_status=$?
set -e
if [[ "$partial_manual_finalize_status" -ne 87 ]] \
  || [[ ! -e "$test_root/first-deploy/pending-image" ]]; then
  printf 'manual partial-finalize fixture was not retained\n' >&2
  exit 1
fi
cp -a "$test_root/first-deploy" "$test_root/partial-manual-missing-live"
cp -a "$test_root/first-deploy" "$test_root/partial-manual-corrupt-live"
rm -f "$test_root/partial-manual-missing-live/compose.yaml"
printf 'tampered-after-health\n' \
  >"$test_root/partial-manual-corrupt-live/compose.yaml"
for invalid_partial_manual_root in \
  "$test_root/partial-manual-missing-live" \
  "$test_root/partial-manual-corrupt-live"; do
  cp -a "$invalid_partial_manual_root" "$invalid_partial_manual_root.expected"
  set +e
  PATH="$test_root/bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
    COFORGE_APP_ROOT="$invalid_partial_manual_root" \
    COFORGE_PUBLIC_HEALTH_RESULT=not-applicable \
    COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
    COFORGE_WSS_HEALTH_RESULT=not-applicable COFORGE_TCP80_RESULT=passed \
    COFORGE_RUNNING_DIGEST_RESULT=not-applicable \
    "$release_script" --finalize-rollback
  invalid_partial_manual_status=$?
  set -e
  if [[ "$invalid_partial_manual_status" -ne 74 ]] \
    || ! diff -r "$invalid_partial_manual_root.expected" \
      "$invalid_partial_manual_root" >/dev/null; then
    printf 'partial manual retry published invalid live Compose state\n' >&2
    exit 1
  fi
done
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/first-deploy" \
  COFORGE_PUBLIC_HEALTH_RESULT=not-applicable \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=not-applicable \
  COFORGE_RUNNING_DIGEST_RESULT=not-applicable \
  "$release_script" --finalize-rollback
if [[ -e "$test_root/first-deploy/current-image" ]] \
  || [[ "$(<"$test_root/first-deploy/previous-image")" != "$first_image" ]]; then
  printf 'verified empty-state rollback was not durably finalized\n' >&2
  exit 1
fi
if [[ "$(sed -n '3p' "$test_root/first-deploy/release-state")" != none ]] \
  || [[ ! "$(sed -n '4p' "$test_root/first-deploy/release-state")" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'empty-state rollback lost the previous image Compose generation\n' >&2
  exit 1
fi
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_TRANSACTION_OWNER='invalid owner' \
  COFORGE_APP_ROOT="$test_root/first-deploy" \
  "$release_script" --rollback; then
  printf 'rollback from empty accepted an invalid owner identity\n' >&2
  exit 1
fi
if [[ -e "$test_root/first-deploy/pending-manual-from" ]] \
  || [[ -e "$test_root/first-deploy/pending-image" ]]; then
  printf 'invalid rollback from empty leaked transaction metadata\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/first-deploy" \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" --rollback
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/first-deploy" \
  COFORGE_PUBLIC_HEALTH_RESULT=passed \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=passed \
  "$release_script" --finalize-rollback
if [[ "$(<"$test_root/first-deploy/current-image")" != "$first_image" ]] \
  || [[ -e "$test_root/first-deploy/previous-image" ]]; then
  printf 'rollback from empty state did not restore the saved image generation\n' >&2
  exit 1
fi

mkdir -p "$test_root/standalone-rollback-failure"
printf 'release: current-only\n' >"$test_root/standalone-rollback-failure/compose.yaml"
printf '%s\n' "$first_image" >"$test_root/standalone-rollback-failure/current-image"
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  FAKE_DOWN_FAIL=true \
  COFORGE_APP_ROOT="$test_root/standalone-rollback-failure" \
  "$release_script" --rollback; then
  printf 'expected standalone rollback shutdown failure\n' >&2
  exit 1
fi
if ! tail -n 1 "$test_root/standalone-rollback-failure/release-history.jsonl" \
  | grep -Fq '"outcome":"failed_rollback"'; then
  printf 'standalone rollback failure did not create a durable audit record\n' >&2
  exit 1
fi
if tail -n 1 "$test_root/standalone-rollback-failure/release-history.jsonl" \
  | grep -Fq 'unknown' \
  || ! tail -n 1 "$test_root/standalone-rollback-failure/release-history.jsonl" \
    | grep -Fq '"next_rollback_digest":"bootstrap:empty"'; then
  printf 'standalone rollback failure lost its known release identities\n' >&2
  exit 1
fi

mkdir -p "$test_root/socket-app"
printf 'release: socket\n' >"$test_root/socket-app/compose.yaml"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  FAKE_EXPECTED_DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock" \
  COFORGE_APP_ROOT="$test_root/socket-app" \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$first_image"

printf 'release: first\n' >"$test_root/app/compose.yaml"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/app" \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$first_image"

if [[ "$(<"$test_root/app/current-image")" != "$first_image" ]]; then
  printf 'first healthy image was not recorded\n' >&2
  exit 1
fi
if ! grep -Fq ' up --detach --wait --wait-timeout 60 --no-build gateway' "$docker_log"; then
  printf 'deployment did not disable Compose builds\n' >&2
  exit 1
fi

cp "$test_root/app/compose.yaml" "$test_root/app/previous-compose.yaml"
printf 'release: activation-failure\n' >"$test_root/app/compose.yaml"
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  FAKE_COMPOSE_FAIL_IMAGE="$second_image" \
  COFORGE_APP_ROOT="$test_root/app" \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$second_image"; then
  printf 'expected unhealthy image deployment to fail\n' >&2
  exit 1
fi

if [[ "$(<"$test_root/app/current-image")" != "$first_image" ]]; then
  printf 'failed deployment did not preserve the previous image\n' >&2
  exit 1
fi
if [[ "$(<"$test_root/app/compose.yaml")" != 'release: first' ]]; then
  printf 'activation failure did not restore the previous Compose definition\n' >&2
  exit 1
fi

if ! tail -n 1 "$docker_log" | grep -Fq "$first_image"; then
  printf 'activation failure did not restore the previous image\n' >&2
  exit 1
fi

cp "$test_root/app/compose.yaml" "$test_root/app/previous-compose.yaml"
printf 'release: internal-health-failure\n' >"$test_root/app/compose.yaml"
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  FAKE_HEALTH_FAIL_IMAGE="$third_image" \
  COFORGE_APP_ROOT="$test_root/app" \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$third_image"; then
  printf 'expected internal health failure to fail deployment\n' >&2
  exit 1
fi
if [[ "$(<"$test_root/app/current-image")" != "$first_image" ]]; then
  printf 'internal health failure did not preserve the previous image\n' >&2
  exit 1
fi
if [[ "$(<"$test_root/app/compose.yaml")" != 'release: first' ]]; then
  printf 'internal health failure did not restore the previous Compose definition\n' >&2
  exit 1
fi

cp "$test_root/app/compose.yaml" "$test_root/app/previous-compose.yaml"
printf 'release: fourth\n' >"$test_root/app/compose.yaml"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/app" \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" "$fourth_image"

printf 'release: corrupted compatibility view\n' >"$test_root/app/previous-compose.yaml"
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/app" \
  COFORGE_HEALTH_ATTEMPTS=1 \
  "$release_script" --rollback

if [[ "$(<"$test_root/app/current-image")" != "$fourth_image" ]] \
  || [[ ! -e "$test_root/app/pending-rollback-complete" ]]; then
  printf 'explicit rollback changed release records before external verification\n' >&2
  exit 1
fi
if [[ "$(<"$test_root/app/compose.yaml")" != 'release: first' ]]; then
  printf 'explicit rollback did not restore the previous Compose definition\n' >&2
  exit 1
fi
if [[ -e "$test_root/app/release-history.jsonl" ]] \
  && tail -n 1 "$test_root/app/release-history.jsonl" | grep -Fq '"outcome":"rolled_back"'; then
  printf 'explicit rollback was audited as complete before external verification\n' >&2
  exit 1
fi
PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/app" \
  COFORGE_PUBLIC_HEALTH_RESULT=passed \
  COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
  COFORGE_WSS_HEALTH_RESULT=passed \
  COFORGE_RUNNING_DIGEST_RESULT=passed \
  "$release_script" --finalize-rollback
if [[ "$(<"$test_root/app/current-image")" != "$first_image" ]] \
  || [[ "$(<"$test_root/app/previous-image")" != "$fourth_image" ]]; then
  printf 'verified explicit rollback did not atomically swap release records\n' >&2
  exit 1
fi
if [[ "$(sed -n '1p' "$test_root/app/release-state")" != "$first_image" ]] \
  || [[ "$(sed -n '2p' "$test_root/app/release-state")" != "$fourth_image" ]] \
  || [[ ! "$(sed -n '3p' "$test_root/app/release-state")" =~ ^[0-9a-f]{64}$ ]] \
  || [[ ! "$(sed -n '4p' "$test_root/app/release-state")" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'manual rollback did not atomically publish a complete release generation\n' >&2
  exit 1
fi
if ! tail -n 1 "$test_root/app/release-history.jsonl" \
  | grep -Fq '"outcome":"rolled_back"'; then
  printf 'finalized manual rollback did not create a durable audit record\n' >&2
  exit 1
fi
if [[ -e "$test_root/app/pending-image" ]]; then
  printf 'finalized manual rollback left pending transaction evidence\n' >&2
  exit 1
fi

mkdir -p "$test_root/root-bin"
cat >"$test_root/root-bin/id" <<'EOF'
#!/usr/bin/env sh
printf '0\n'
EOF
chmod 0755 "$test_root/root-bin/id"
if PATH="$test_root/root-bin:$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/app" \
  "$release_script" "$first_image"; then
  printf 'expected root deployment to be rejected\n' >&2
  exit 1
fi

if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  FAKE_ROOTLESS_DOCKER=false \
  COFORGE_APP_ROOT="$test_root/app" \
  "$release_script" "$first_image"; then
  printf 'expected a rootful Docker daemon to be rejected\n' >&2
  exit 1
fi

if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/app" \
  COFORGE_EDGE_BIND_IP=203.0.113.10 \
  "$release_script" "$first_image"; then
  printf 'expected a public edge bind address to be rejected\n' >&2
  exit 1
fi

if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/app" \
  "$release_script" "$registry:latest"; then
  printf 'expected mutable image tag to be rejected\n' >&2
  exit 1
fi

mkdir -p "$test_root/corrupt-pending"
printf 'release: corrupt\n' >"$test_root/corrupt-pending/compose.yaml"
printf '%s\n' "$first_image" >"$test_root/corrupt-pending/current-image"
printf 'partial\n' >"$test_root/corrupt-pending/pending-image"
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/corrupt-pending" \
  "$release_script" --rollback; then
  printf 'expected corrupt pending evidence to stop rollback mutation\n' >&2
  exit 1
fi

mkdir -p "$test_root/invalid-manual"
printf 'release: current\n' >"$test_root/invalid-manual/compose.yaml"
printf '%s\n' "$first_image" >"$test_root/invalid-manual/current-image"
if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_APP_ROOT="$test_root/invalid-manual" \
  COFORGE_EXECUTOR='invalid executor' \
  "$release_script" --rollback; then
  printf 'manual rollback accepted an invalid executor identity\n' >&2
  exit 1
fi
if [[ -e "$test_root/invalid-manual/pending-image" ]] \
  || [[ "$(<"$test_root/invalid-manual/current-image")" != "$first_image" ]]; then
  printf 'invalid manual input published or mutated a transaction\n' >&2
  exit 1
fi

if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_INTERNAL_TEST_MODE='' \
  COFORGE_APP_ROOT="$test_root/app" \
  "$release_script" "$first_image"; then
  printf 'expected direct image deployment without external gates to be rejected\n' >&2
  exit 1
fi

while IFS= read -r record; do
  if [[ "$record" != *'"track":"cloud-application"'* ]]; then
    printf 'release record is missing its cloud track identity: %s\n' "$record" >&2
    exit 1
  fi
done < <(find "$test_root" -type f -name release-history.jsonl -exec cat {} +)

printf 'compose release script tests passed\n'
