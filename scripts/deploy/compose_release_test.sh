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

registry=ghcr.io/lrm-teams/coforge-realtime-gateway
first_image="$registry@sha256:$(printf '1%.0s' {1..64})"
second_image="$registry@sha256:$(printf '2%.0s' {1..64})"
third_image="$registry@sha256:$(printf '3%.0s' {1..64})"
fourth_image="$registry@sha256:$(printf '4%.0s' {1..64})"
docker_log="$test_root/docker.log"
source_commit=$(printf 'a%.0s' {1..40})
workflow_run=https://github.com/LRM-Teams/coforge/actions/runs/12345

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
printf 'release: candidate\n' >"$test_root/failed-rollback/candidate.yaml"
printf '%s\n' "$first_image" >"$test_root/failed-rollback/current-image"
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
  | grep -Fq '"next_rollback_digest"'; then
  printf 'failed rollback did not retain the next rollback identity\n' >&2
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

if PATH="$test_root/bin:$PATH" \
  FAKE_DOCKER_LOG="$docker_log" \
  COFORGE_INTERNAL_TEST_MODE='' \
  COFORGE_APP_ROOT="$test_root/app" \
  "$release_script" "$first_image"; then
  printf 'expected direct image deployment without external gates to be rejected\n' >&2
  exit 1
fi

printf 'compose release script tests passed\n'
