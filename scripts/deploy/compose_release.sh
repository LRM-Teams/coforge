#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'usage: %s <immutable-image-reference|--commit|--commit-status|--rollback|--finalize-rollback|--record-interruption|--record-failed-rollback|--adopt-interrupted|--current-image|--previous-image|--rollback-target-image>\n' "$0" >&2
  exit 64
fi

deploy_uid=$(id -u)
if [[ "$deploy_uid" -eq 0 ]]; then
  printf 'deployment must run as a dedicated non-root user\n' >&2
  exit 77
fi
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-"/run/user/$deploy_uid"}
export DOCKER_HOST=${DOCKER_HOST:-"unix://$XDG_RUNTIME_DIR/docker.sock"}

app_root=${COFORGE_APP_ROOT:-"$HOME/.local/share/coforge/realtime-gateway"}
project_name=${COFORGE_COMPOSE_PROJECT:-coforge-test}
edge_bind_ip=${COFORGE_EDGE_BIND_IP:-127.0.0.1}
health_url=${COFORGE_HEALTH_URL:-"http://$edge_bind_ip:18180/readyz"}
health_attempts=${COFORGE_HEALTH_ATTEMPTS:-20}
compose_file="$app_root/compose.yaml"
candidate_compose_file=${COFORGE_CANDIDATE_COMPOSE:-"$compose_file"}
previous_compose_file="$app_root/previous-compose.yaml"
rollback_compose_backup="$app_root/.compose.before-rollback"
rollback_compose_backup_digest_file="$app_root/.compose.before-rollback.digest"
current_image_file="$app_root/current-image"
previous_image_file="$app_root/previous-image"
pending_image_file="$app_root/pending-image"
pending_previous_image_file="$app_root/pending-previous-image"
pending_source_commit_file="$app_root/pending-source-commit"
pending_workflow_run_file="$app_root/pending-workflow-run"
pending_executor_file="$app_root/pending-executor"
pending_started_at_file="$app_root/pending-started-at"
pending_origin_file="$app_root/pending-origin"
pending_owner_file="$app_root/pending-owner"
pending_manual_from_file="$app_root/pending-manual-from"
pending_previous_compose_file="$app_root/pending-previous-compose.yaml"
pending_previous_compose_digest_file="$app_root/pending-previous-compose.digest"
pending_prior_previous_image_file="$app_root/pending-prior-previous-image"
pending_prior_previous_compose_file="$app_root/pending-prior-previous-compose.yaml"
pending_prior_previous_compose_digest_file="$app_root/pending-prior-previous-compose.digest"
pending_rollback_complete_file="$app_root/pending-rollback-complete"
pending_failure_file="$app_root/pending-failure-stage"
history_file="$app_root/release-history.jsonl"
state_file="$app_root/release-state"
compose_store="$app_root/compose-generations"
next_state_file="$app_root/.release-state.next"
next_image_file="$app_root/.current-image.next"
next_previous_file="$app_root/.previous-image.next"
next_pending_image_file="$app_root/.pending-image.next"
pre_marker_active_file="$app_root/.pre-marker-active"
pending_audit_failed_file="$app_root/pending-audit-write-failed"
pre_marker_image=
pre_marker_previous=bootstrap:empty
pre_marker_source_commit=
pre_marker_workflow_run=
pre_marker_executor=
pre_marker_started_at=

state_field() {
  local field=$1
  if [[ -r "$state_file" ]]; then
    sed -n "${field}p" "$state_file"
  fi
}

compose_generation_path() {
  local digest=$1
  local path
  if [[ "$digest" == none ]]; then
    return 1
  fi
  if [[ ! "$digest" =~ ^[0-9a-f]{64}$ ]]; then
    printf 'release-state contains an invalid Compose generation\n' >&2
    exit 65
  fi
  path="$compose_store/$digest.yaml"
  if [[ ! -r "$path" ]] \
    || [[ "$(sha256sum "$path" | cut -d ' ' -f 1)" != "$digest" ]]; then
    printf 'authoritative Compose generation is missing or corrupt\n' >&2
    exit 65
  fi
  printf '%s\n' "$path"
}

store_compose() {
  local source=$1
  local digest generation_path temporary_generation
  if [[ ! -r "$source" ]]; then
    printf 'none\n'
    return
  fi
  digest=$(sha256sum "$source" | cut -d ' ' -f 1)
  generation_path="$compose_store/$digest.yaml"
  if [[ ! -r "$generation_path" ]] \
    || [[ "$(sha256sum "$generation_path" 2>/dev/null | cut -d ' ' -f 1)" != "$digest" ]]; then
    temporary_generation=$(mktemp "$compose_store/.generation.XXXXXX")
    install -m 0600 "$source" "$temporary_generation"
    if [[ "$(sha256sum "$temporary_generation" | cut -d ' ' -f 1)" != "$digest" ]]; then
      rm -f -- "$temporary_generation"
      printf 'Compose generation copy failed verification\n' >&2
      exit 65
    fi
    mv -f "$temporary_generation" "$generation_path"
  fi
  printf '%s\n' "$digest"
}

write_release_state() {
  local current=$1
  local previous=$2
  local current_compose_source=$3
  local previous_compose_source=$4
  local current_compose_digest previous_compose_digest
  mkdir -p "$compose_store"
  current_compose_digest=$(store_compose "$current_compose_source")
  previous_compose_digest=$(store_compose "$previous_compose_source")
  printf '%s\n%s\n%s\n%s\n' \
    "$current" "$previous" "$current_compose_digest" "$previous_compose_digest" \
    >"$next_state_file"
  mv -f "$next_state_file" "$state_file"

  # Compatibility views are non-authoritative; release-state is the single pointer.
  if [[ "$current" == bootstrap:empty ]]; then
    rm -f -- "$current_image_file"
  else
    printf '%s\n' "$current" >"$next_image_file"
    mv -f "$next_image_file" "$current_image_file"
  fi
  if [[ "$previous" == bootstrap:empty ]]; then
    rm -f -- "$previous_image_file" "$previous_compose_file"
  else
    printf '%s\n' "$previous" >"$next_previous_file"
    mv -f "$next_previous_file" "$previous_image_file"
    if [[ "$previous_compose_digest" != none ]]; then
      cp -f "$compose_store/$previous_compose_digest.yaml" "$previous_compose_file"
    fi
  fi
}

clear_pending() {
  rm -f -- "$pending_image_file" "$pending_previous_image_file" \
    "$pending_source_commit_file" "$pending_workflow_run_file" \
    "$pending_executor_file" "$pending_started_at_file" \
    "$pending_origin_file" "$pending_owner_file" "$pending_manual_from_file" \
    "$pending_prior_previous_image_file" "$pending_prior_previous_compose_file" \
    "$pending_prior_previous_compose_digest_file" \
    "$pending_previous_compose_file" "$pending_previous_compose_digest_file" \
    "$pending_rollback_complete_file" \
    "$pending_failure_file" "$next_pending_image_file" \
    "$rollback_compose_backup" "$rollback_compose_backup_digest_file" \
    "$pre_marker_active_file" \
    "$pending_audit_failed_file"
}

# Invoked by traps while sidecars are being staged. It must record immediately:
# returning to an interrupted external command would let `set -e` exit before
# the discovery marker is published.
# shellcheck disable=SC2329
record_pre_marker_interruption() {
  local signal=$1
  local completed_at image image_digest previous_digest
  trap - ERR HUP INT TERM
  set +e
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  image=${pre_marker_image%@*}
  image_digest=${pre_marker_image##*@}
  previous_digest=$pre_marker_previous
  if [[ "$previous_digest" != bootstrap:empty ]]; then
    previous_digest=${previous_digest##*@}
  fi
  if ! printf '{"source_commit":"%s","track":"cloud-application","image":"%s","image_digest":"%s","environment":"test","workflow_run":"%s","previous_digest":"%s","health_result":"signal_%s=interrupted","final_observed_state":"unchanged","approval":"not-required","executor":"%s","started_at":"%s","completed_at":"%s","outcome":"interrupted"}\n' \
    "$pre_marker_source_commit" "$image" "$image_digest" \
    "$pre_marker_workflow_run" "$previous_digest" "$signal" \
    "$pre_marker_executor" "$pre_marker_started_at" "$completed_at" \
    >>"$history_file"; then
    if [[ -e "$pre_marker_active_file" ]] \
      && mv -f "$pre_marker_active_file" "$pending_audit_failed_file"; then
      :
    elif ! : >"$pending_audit_failed_file"; then
      printf 'pre-marker audit failure marker could not be published; active evidence retained\n' >&2
      exit 74
    fi
    printf 'pre-marker interruption audit failed; recovery evidence retained\n' >&2
    exit 74
  fi
  clear_pending
  exit 130
}

record_failed_preparation() {
  local failure_stage=$1
  local completed_at image image_digest previous_digest
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  image=${release_image%@*}
  image_digest=${release_image##*@}
  if [[ "$previous_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    previous_digest=${previous_image##*@}
  else
    previous_digest=bootstrap:empty
  fi
  printf '{"source_commit":"%s","track":"cloud-application","image":"%s","image_digest":"%s","environment":"test","workflow_run":"%s","previous_digest":"%s","health_result":"pre_mutation_%s=failed","final_observed_state":"unchanged","approval":"not-required","executor":"%s","started_at":"%s","completed_at":"%s","outcome":"failed_preparation"}\n' \
    "$source_commit" "$image" "$image_digest" "$workflow_run" \
    "$previous_digest" "$failure_stage" "$executor" "$started_at" \
    "$completed_at" >>"$history_file"
  clear_pending
}

record_interruption() {
  local signal=$1
  local completed_at image image_digest previous_digest interrupted_image final_state
  local source_commit workflow_run executor started_at
  trap - ERR HUP INT TERM
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  interrupted_image=$(cat "$pending_image_file" 2>/dev/null || true)
  final_state=pending-recovery
  if [[ ! "$interrupted_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] \
    && [[ "${release_image:-}" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    interrupted_image=$release_image
    final_state=unchanged
  fi
  source_commit=$(cat "$pending_source_commit_file" 2>/dev/null || true)
  workflow_run=$(cat "$pending_workflow_run_file" 2>/dev/null || true)
  executor=$(cat "$pending_executor_file" 2>/dev/null || true)
  started_at=$(cat "$pending_started_at_file" 2>/dev/null || true)
  image=${interrupted_image%@*}
  image_digest=${interrupted_image##*@}
  previous_digest=$(cat "$pending_previous_image_file" 2>/dev/null || true)
  if [[ "$previous_digest" != bootstrap:empty ]]; then
    previous_digest=${previous_digest##*@}
  fi
  if [[ ! -e "$pending_failure_file" ]]; then
    printf '%s\n' interrupted >"$pending_failure_file"
  fi
  if ! printf '{"source_commit":"%s","track":"cloud-application","image":"%s","image_digest":"%s","environment":"test","workflow_run":"%s","previous_digest":"%s","health_result":"signal_%s=interrupted","final_observed_state":"%s","approval":"not-required","executor":"%s","started_at":"%s","completed_at":"%s","outcome":"interrupted"}\n' \
    "$source_commit" "$image" "$image_digest" "$workflow_run" \
    "$previous_digest" "$signal" "$final_state" "$executor" "$started_at" \
    "$completed_at" >>"$history_file"; then
    if [[ -e "$pre_marker_active_file" ]] \
      && mv -f "$pre_marker_active_file" "$pending_audit_failed_file"; then
      :
    elif ! : >"$pending_audit_failed_file"; then
      printf 'formal interruption audit failure marker could not be published; pending evidence retained\n' >&2
      exit 74
    fi
    printf 'formal interruption audit failed; pending evidence retained\n' >&2
    exit 74
  fi
  if ! rm -f -- "$pre_marker_active_file"; then
    printf 'formal interruption was audited but active sentinel cleanup failed\n' >&2
    exit 74
  fi
  if [[ "$final_state" == unchanged ]]; then
    clear_pending
  fi
  exit 130
}

record_orphaned_pending() {
  local pending_image pending_previous source_commit workflow_run executor started_at
  local completed_at image image_digest previous_digest
  if [[ -e "$pending_failure_file" ]]; then
    return 0
  fi
  pending_image=$(cat "$pending_image_file" 2>/dev/null || true)
  pending_previous=$(cat "$pending_previous_image_file" 2>/dev/null || true)
  source_commit=$(cat "$pending_source_commit_file" 2>/dev/null || true)
  workflow_run=$(cat "$pending_workflow_run_file" 2>/dev/null || true)
  executor=$(cat "$pending_executor_file" 2>/dev/null || true)
  started_at=$(cat "$pending_started_at_file" 2>/dev/null || true)
  if [[ ! "$pending_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] \
    || [[ ! "$source_commit" =~ ^[0-9a-f]{40}$ ]] \
    || [[ ! "$workflow_run" =~ ^https://github\.com/[A-Za-z0-9._/-]+/actions/runs/[0-9]+$ ]] \
    || [[ ! "$executor" =~ ^[A-Za-z0-9._@/-]+$ ]] \
    || [[ ! "$started_at" =~ ^[0-9TZ:.-]+$ ]]; then
    printf 'orphaned pending release evidence is invalid\n' >&2
    return 0
  fi
  if [[ "$pending_previous" == bootstrap:empty ]]; then
    previous_digest=bootstrap:empty
  elif [[ "$pending_previous" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    previous_digest=${pending_previous##*@}
  else
    printf 'orphaned pending previous release evidence is invalid\n' >&2
    return 0
  fi
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  image=${pending_image%@*}
  image_digest=${pending_image##*@}
  printf 'interrupted\n' >"$pending_failure_file"
  printf '{"source_commit":"%s","track":"cloud-application","image":"%s","image_digest":"%s","environment":"test","workflow_run":"%s","previous_digest":"%s","health_result":"previous_job=interrupted","final_observed_state":"pending-recovery","approval":"not-required","executor":"%s","started_at":"%s","completed_at":"%s","outcome":"interrupted"}\n' \
    "$source_commit" "$image" "$image_digest" "$workflow_run" \
    "$previous_digest" "$executor" "$started_at" "$completed_at" \
    >>"$history_file"
}

record_standalone_rollback() {
  local attempted_image=$1
  local resulting_digest=$2
  local health_result=$3
  local outcome=${4:-rolled_back}
  local next_rollback_digest=${5:-$2}
  local completed_at image image_digest executor_name
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  image=${attempted_image%@*}
  image_digest=${attempted_image##*@}
  executor_name=${COFORGE_EXECUTOR:-local}
  if [[ ! "$executor_name" =~ ^[A-Za-z0-9._@/-]+$ ]]; then
    executor_name=local
  fi
  printf '{"source_commit":"manual","track":"cloud-application","image":"%s","image_digest":"%s","environment":"test","workflow_run":"manual","previous_digest":"%s","health_result":"%s","final_observed_state":"current_digest=%s","next_rollback_digest":"%s","approval":"not-required","executor":"%s","started_at":"%s","completed_at":"%s","outcome":"%s"}\n' \
    "$image" "$image_digest" "$resulting_digest" "$health_result" \
    "$resulting_digest" "$next_rollback_digest" "$executor_name" \
    "$completed_at" "$completed_at" "$outcome" \
    >>"$history_file"
}

healthy_commit_recorded() {
  local expected_image=$1
  local expected_workflow_run=$2
  local expected_digest=${expected_image##*@}
  [[ -f "$history_file" ]] && [[ -r "$history_file" ]] || return 1
  awk -v digest="$expected_digest" -v workflow="$expected_workflow_run" '
    index($0, "\"image_digest\":\"" digest "\"") &&
    index($0, "\"workflow_run\":\"" workflow "\"") &&
    index($0, "\"outcome\":\"healthy\"") { found = 1 }
    END { exit !found }
  ' "$history_file"
}

require_pending_owner() {
  local expected_owner supplied_owner
  expected_owner=$(cat "$pending_owner_file" 2>/dev/null || true)
  supplied_owner=${COFORGE_TRANSACTION_OWNER:-manual}
  if [[ ! "$expected_owner" =~ ^[A-Za-z0-9._-]+$ ]] \
    || [[ "$supplied_owner" != "$expected_owner" ]]; then
    printf 'transaction owner does not match pending release\n' >&2
    exit 73
  fi
}

formal_pending_evidence_valid() {
  local pending_image pending_previous source_commit workflow_run executor
  local started_at origin owner pending_prior previous_compose_digest
  local prior_compose_digest state_current state_previous
  local state_current_compose state_previous_compose state_generation
  local manual_from rollback_backup_digest
  pending_image=$(cat "$pending_image_file" 2>/dev/null || true)
  pending_previous=$(cat "$pending_previous_image_file" 2>/dev/null || true)
  source_commit=$(cat "$pending_source_commit_file" 2>/dev/null || true)
  workflow_run=$(cat "$pending_workflow_run_file" 2>/dev/null || true)
  executor=$(cat "$pending_executor_file" 2>/dev/null || true)
  started_at=$(cat "$pending_started_at_file" 2>/dev/null || true)
  origin=$(cat "$pending_origin_file" 2>/dev/null || true)
  owner=$(cat "$pending_owner_file" 2>/dev/null || true)

  [[ "$pending_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] \
    && { [[ "$pending_previous" == bootstrap:empty ]] \
      || [[ "$pending_previous" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; } \
    && [[ "$executor" =~ ^[A-Za-z0-9._@/-]+$ ]] \
    && [[ "$started_at" =~ ^[0-9TZ:.-]+$ ]] \
    && [[ "$owner" =~ ^[A-Za-z0-9._-]+$ ]] \
    || return 1

  if [[ "$origin" == manual ]]; then
    [[ "$source_commit" == manual ]] \
      && [[ "$workflow_run" == manual ]] \
      && [[ -r "$compose_file" ]] || return 1
    manual_from=$(cat "$pending_manual_from_file" 2>/dev/null || true)
    rollback_backup_digest=$(cat "$rollback_compose_backup_digest_file" 2>/dev/null || true)
    previous_compose_digest=$(cat "$pending_previous_compose_digest_file" 2>/dev/null || true)
    if [[ "$pending_previous" == bootstrap:empty ]]; then
      [[ "$previous_compose_digest" == none ]] \
        && [[ ! -e "$pending_previous_compose_file" ]] || return 1
    else
      [[ "$previous_compose_digest" =~ ^[0-9a-f]{64}$ ]] \
        && [[ -r "$pending_previous_compose_file" ]] \
        && [[ "$(sha256sum "$pending_previous_compose_file" | cut -d ' ' -f 1)" == "$previous_compose_digest" ]] \
        || return 1
    fi
    if [[ "$manual_from" == bootstrap:empty ]]; then
      [[ "$pending_image" == "$pending_previous" ]] \
        && [[ "$rollback_backup_digest" == none ]] \
        && [[ ! -e "$rollback_compose_backup" ]] || return 1
    elif [[ -z "$manual_from" ]]; then
      [[ "$pending_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] \
        && [[ "$rollback_backup_digest" =~ ^[0-9a-f]{64}$ ]] \
        && [[ -r "$rollback_compose_backup" ]] \
        && [[ "$(sha256sum "$rollback_compose_backup" | cut -d ' ' -f 1)" == "$rollback_backup_digest" ]] \
        || return 1
    else
      return 1
    fi
    if [[ -r "$state_file" ]]; then
      state_current=$(state_field 1)
      state_previous=$(state_field 2)
      state_current_compose=$(state_field 3)
      state_previous_compose=$(state_field 4)
      if [[ "$manual_from" == bootstrap:empty ]]; then
        if [[ "$state_current" == bootstrap:empty ]] \
          && [[ "$state_previous" == "$pending_previous" ]] \
          && [[ "$state_current_compose" == none ]] \
          && [[ "$state_previous_compose" == "$previous_compose_digest" ]]; then
          :
        elif [[ "$state_current" == "$pending_previous" ]] \
          && [[ "$state_previous" == bootstrap:empty ]] \
          && [[ "$state_current_compose" == "$previous_compose_digest" ]] \
          && [[ "$state_previous_compose" == none ]]; then
          :
        else
          return 1
        fi
      else
        if [[ "$state_current" == "$pending_image" ]] \
          && [[ "$state_previous" == "$pending_previous" ]] \
          && [[ "$state_current_compose" == "$rollback_backup_digest" ]] \
          && [[ "$state_previous_compose" == "$previous_compose_digest" ]]; then
          :
        elif [[ "$state_current" == "$pending_previous" ]] \
          && [[ "$state_previous" == "$pending_image" ]] \
          && [[ "$state_current_compose" == "$previous_compose_digest" ]] \
          && [[ "$state_previous_compose" == "$rollback_backup_digest" ]]; then
          :
        else
          return 1
        fi
      fi
    fi
    return
  fi
  [[ "$origin" == release ]] \
    && [[ "$executor" == github-actions ]] \
    && [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] \
    && [[ "$workflow_run" =~ ^https://github\.com/[A-Za-z0-9._/-]+/actions/runs/[0-9]+$ ]] \
    || return 1

  pending_prior=$(cat "$pending_prior_previous_image_file" 2>/dev/null || true)
  previous_compose_digest=$(cat "$pending_previous_compose_digest_file" 2>/dev/null || true)
  prior_compose_digest=$(cat "$pending_prior_previous_compose_digest_file" 2>/dev/null || true)
  if [[ "$pending_previous" == bootstrap:empty ]]; then
    [[ "$previous_compose_digest" == none ]] \
      && [[ ! -e "$pending_previous_compose_file" ]] || return 1
  else
    [[ "$previous_compose_digest" =~ ^[0-9a-f]{64}$ ]] \
      && [[ -r "$pending_previous_compose_file" ]] \
      && [[ "$(sha256sum "$pending_previous_compose_file" | cut -d ' ' -f 1)" == "$previous_compose_digest" ]] \
      || return 1
  fi
  if [[ "$pending_prior" == bootstrap:empty ]]; then
    [[ "$prior_compose_digest" == none ]] \
      && [[ ! -e "$pending_prior_previous_compose_file" ]] || return 1
  elif [[ "$pending_prior" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    [[ "$prior_compose_digest" =~ ^[0-9a-f]{64}$ ]] \
      && [[ -r "$pending_prior_previous_compose_file" ]] \
      && [[ "$(sha256sum "$pending_prior_previous_compose_file" | cut -d ' ' -f 1)" == "$prior_compose_digest" ]] \
      || return 1
  else
    return 1
  fi
  if [[ -r "$state_file" ]]; then
    state_current=$(state_field 1)
    state_previous=$(state_field 2)
    state_current_compose=$(state_field 3)
    state_previous_compose=$(state_field 4)
    if [[ "$state_current" == "$pending_previous" ]] \
      && [[ "$state_previous" == "$pending_prior" ]] \
      && [[ "$state_current_compose" == "$previous_compose_digest" ]] \
      && [[ "$state_previous_compose" == "$prior_compose_digest" ]]; then
      :
    elif [[ "$state_current" == "$pending_image" ]] \
      && [[ "$state_previous" == "$pending_previous" ]] \
      && [[ "$state_previous_compose" == "$previous_compose_digest" ]] \
      && [[ "$state_current_compose" =~ ^[0-9a-f]{64}$ ]]; then
      state_generation="$compose_store/$state_current_compose.yaml"
      [[ -r "$state_generation" ]] \
        && [[ "$(sha256sum "$state_generation" | cut -d ' ' -f 1)" == "$state_current_compose" ]] \
        || return 1
    else
      return 1
    fi
  fi
}

if [[ "$1" != --record-failed-rollback ]] && [[ "$1" != --record-interruption ]] \
  && [[ "$1" != --commit-status ]] \
  && [[ "$1" != --current-image ]] && [[ "$1" != --previous-image ]] \
  && [[ "$1" != --rollback-target-image ]] \
  && [[ "$1" != --adopt-interrupted ]]; then
  docker_security_options=$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null || true)
  if [[ "$docker_security_options" != *'"name=rootless"'* ]]; then
    printf 'deployment requires a rootless Docker daemon\n' >&2
    exit 77
  fi
fi

if [[ ! "$edge_bind_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  printf 'COFORGE_EDGE_BIND_IP must be a private or loopback IPv4 address\n' >&2
  exit 64
fi
IFS=. read -r edge_o1 edge_o2 edge_o3 edge_o4 <<<"$edge_bind_ip"
for edge_octet in "$edge_o1" "$edge_o2" "$edge_o3" "$edge_o4"; do
  if ((10#$edge_octet > 255)); then
    printf 'COFORGE_EDGE_BIND_IP must be a private or loopback IPv4 address\n' >&2
    exit 64
  fi
done
if ! ((10#$edge_o1 == 10 \
  || 10#$edge_o1 == 127 \
  || (10#$edge_o1 == 192 && 10#$edge_o2 == 168) \
  || (10#$edge_o1 == 172 && 10#$edge_o2 >= 16 && 10#$edge_o2 <= 31))); then
  printf 'COFORGE_EDGE_BIND_IP must be a private or loopback IPv4 address\n' >&2
  exit 64
fi

case "$health_attempts" in
  ''|*[!0-9]*|0)
    printf 'COFORGE_HEALTH_ATTEMPTS must be a positive integer\n' >&2
    exit 64
    ;;
esac

if [[ "$1" != --commit ]] && [[ "$1" != --finalize-rollback ]] \
  && [[ "$1" != --record-interruption ]] \
  && [[ "$1" != --commit-status ]] \
  && [[ "$1" != --current-image ]] && [[ "$1" != --previous-image ]] \
  && [[ "$1" != --rollback-target-image ]] \
  && [[ "$1" != --adopt-interrupted ]] \
  && [[ "$1" != --record-failed-rollback ]] \
  && [[ ! -r "$candidate_compose_file" ]]; then
  printf 'candidate compose file is not readable: %s\n' "$candidate_compose_file" >&2
  exit 66
fi

mkdir -p "$app_root"
exec 9>"$app_root/.release.lock"
if ! flock --nonblock 9; then
  printf 'another release operation holds the host lock\n' >&2
  exit 75
fi
if [[ -e "$pending_audit_failed_file" ]]; then
  printf 'a pre-marker interruption audit failed; refusing to discard recovery evidence\n' >&2
  exit 74
fi
if [[ -e "$pre_marker_active_file" ]]; then
  if [[ ! -e "$pending_image_file" ]]; then
    printf 'an active pre-marker transaction has no formal recovery marker; refusing to discard evidence\n' >&2
    exit 74
  fi
  case "$1" in
    --adopt-interrupted|--record-interruption|--record-failed-rollback)
      if ! formal_pending_evidence_valid; then
        printf 'active formal recovery evidence is incomplete or invalid\n' >&2
        exit 74
      fi
      ;;
    *)
      printf 'an incomplete or unaudited transaction exists; refusing to discard recovery evidence\n' >&2
      exit 74
      ;;
  esac
fi
if [[ ! -e "$pending_image_file" ]]; then
  # A transaction is discoverable only after its marker is atomically
  # published. Under the host lock, sidecars without that marker can only be
  # remnants of an interrupted preparation and must not enter a successor.
  clear_pending
fi
if [[ "$1" != --record-failed-rollback ]] && [[ "$1" != --record-interruption ]] \
  && [[ -e "$pending_image_file" ]]; then
  trap 'record_interruption HUP' HUP
  trap 'record_interruption INT' INT
  trap 'record_interruption TERM' TERM
fi
previous_image=$(state_field 1)
recorded_previous_image=$(state_field 2)
current_compose_digest=$(state_field 3)
previous_compose_digest=$(state_field 4)
if [[ -z "$previous_image" ]]; then
  previous_image=$(cat "$current_image_file" 2>/dev/null || true)
fi
if [[ -z "$recorded_previous_image" ]]; then
  recorded_previous_image=$(cat "$previous_image_file" 2>/dev/null || true)
fi
current_compose_source=$compose_file
previous_compose_source=$previous_compose_file
if [[ -r "$state_file" ]]; then
  if [[ "$previous_image" == bootstrap:empty ]]; then
    [[ "$current_compose_digest" == none ]] || {
      printf 'empty current state must not reference a Compose generation\n' >&2
      exit 65
    }
  else
    current_compose_source=$(compose_generation_path "$current_compose_digest")
  fi
  if [[ "$recorded_previous_image" == bootstrap:empty ]]; then
    [[ "$previous_compose_digest" == none ]] || {
      printf 'empty previous state must not reference a Compose generation\n' >&2
      exit 65
    }
  else
    previous_compose_source=$(compose_generation_path "$previous_compose_digest")
  fi
fi
release_image=$1
rollback=false
if [[ "$release_image" == --current-image ]]; then
  if [[ "$previous_image" != bootstrap:empty ]]; then
    printf '%s\n' "$previous_image"
  fi
  exit 0
fi
if [[ "$release_image" == --previous-image ]]; then
  if [[ "$recorded_previous_image" != bootstrap:empty ]]; then
    printf '%s\n' "$recorded_previous_image"
  fi
  exit 0
fi
if [[ "$release_image" == --rollback-target-image ]]; then
  require_pending_owner
  rollback_target=$(cat "$pending_previous_image_file" 2>/dev/null || true)
  if [[ "$rollback_target" == bootstrap:empty ]]; then
    exit 0
  fi
  if [[ ! "$rollback_target" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    printf 'pending rollback target is missing or invalid\n' >&2
    exit 65
  fi
  printf '%s\n' "$rollback_target"
  exit 0
fi
if [[ "$release_image" == --adopt-interrupted ]]; then
  if ! formal_pending_evidence_valid; then
    printf 'formal recovery evidence is incomplete or invalid\n' >&2
    exit 74
  fi
  new_owner=${COFORGE_TRANSACTION_OWNER:-}
  old_owner=$(cat "$pending_owner_file" 2>/dev/null || true)
  pending_executor=$(cat "$pending_executor_file" 2>/dev/null || true)
  pending_image=$(cat "$pending_image_file" 2>/dev/null || true)
  if [[ ! "$new_owner" =~ ^[A-Za-z0-9._-]+$ ]] \
    || [[ ! "$old_owner" =~ ^[A-Za-z0-9._-]+$ ]] \
    || [[ "$new_owner" == "$old_owner" ]] \
    || [[ "$pending_executor" != github-actions ]] \
    || [[ ! "$pending_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    printf 'only an interrupted GitHub Actions transaction may be adopted\n' >&2
    exit 73
  fi
  owner_next_file="$app_root/.pending-owner.next"
  printf '%s\n' "$new_owner" >"$owner_next_file"
  if ! mv -f "$owner_next_file" "$pending_owner_file"; then
    rm -f -- "$owner_next_file"
    printf 'transaction owner handoff failed; formal evidence was unchanged\n' >&2
    exit 74
  fi
  printf 'interrupted transaction adopted by %s\n' "$new_owner"
  exit 0
fi
if [[ "$release_image" == --record-interruption ]]; then
  if ! formal_pending_evidence_valid; then
    printf 'formal recovery evidence is incomplete or invalid\n' >&2
    exit 74
  fi
  require_pending_owner
  record_interruption workflow-cancelled
fi
if [[ "$release_image" == --commit-status ]]; then
  expected_image=${COFORGE_EXPECTED_IMAGE:-}
  expected_workflow_run=${COFORGE_WORKFLOW_RUN:-}
  if [[ ! "$expected_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] \
    || [[ ! "$expected_workflow_run" =~ ^https://github\.com/[A-Za-z0-9._/-]+/actions/runs/[0-9]+$ ]]; then
    printf 'commit status requires valid expected image and workflow run evidence\n' >&2
    exit 64
  fi
  if [[ "$previous_image" != "$expected_image" ]] \
    || [[ -e "$pending_image_file" ]] \
    || ! healthy_commit_recorded "$expected_image" "$expected_workflow_run"; then
    printf 'release commit is not durably recorded\n' >&2
    exit 1
  fi
  printf 'release commit is durably recorded\n'
  exit 0
fi
if [[ "$release_image" == --commit ]]; then
  if ! formal_pending_evidence_valid; then
    printf 'formal recovery evidence is incomplete or invalid\n' >&2
    exit 74
  fi
  require_pending_owner
  if [[ "${COFORGE_PUBLIC_HEALTH_RESULT:-}" != passed ]] \
    || [[ "${COFORGE_SHARED_INGRESS_HEALTH_RESULT:-}" != passed ]] \
    || [[ "${COFORGE_WSS_HEALTH_RESULT:-}" != passed ]] \
    || [[ "${COFORGE_TCP80_RESULT:-}" != passed ]] \
    || [[ "${COFORGE_RUNNING_DIGEST_RESULT:-}" != passed ]]; then
    printf 'commit requires passed public, shared-ingress, WSS, TCP/80-closed, and running-digest evidence\n' >&2
    exit 65
  fi
  pending_image=$(cat "$pending_image_file" 2>/dev/null || true)
  pending_previous_image=$(cat "$pending_previous_image_file" 2>/dev/null || true)
  source_commit=$(cat "$pending_source_commit_file" 2>/dev/null || true)
  workflow_run=$(cat "$pending_workflow_run_file" 2>/dev/null || true)
  executor=$(cat "$pending_executor_file" 2>/dev/null || true)
  started_at=$(cat "$pending_started_at_file" 2>/dev/null || true)
  if [[ ! "$pending_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] \
    || [[ ! "$source_commit" =~ ^[0-9a-f]{40}$ ]] \
    || [[ ! "$workflow_run" =~ ^https://github\.com/[A-Za-z0-9._/-]+/actions/runs/[0-9]+$ ]] \
    || [[ ! "$executor" =~ ^[A-Za-z0-9._@/-]+$ ]] \
    || [[ ! "$started_at" =~ ^[0-9TZ:.-]+$ ]]; then
    printf 'pending release evidence is missing or invalid\n' >&2
    exit 65
  fi
  if [[ "$pending_previous_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    previous_digest=${pending_previous_image##*@}
  elif [[ "$pending_previous_image" == bootstrap:empty ]]; then
    previous_digest=bootstrap:empty
  else
    printf 'pending previous release evidence is invalid\n' >&2
    exit 65
  fi
  write_release_state "$pending_image" "$pending_previous_image" \
    "$compose_file" "$pending_previous_compose_file"
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  image=${pending_image%@*}
  image_digest=${pending_image##*@}
  if ! healthy_commit_recorded "$pending_image" "$workflow_run"; then
  printf '{"source_commit":"%s","track":"cloud-application","image":"%s","image_digest":"%s","environment":"test","workflow_run":"%s","previous_digest":"%s","health_result":"container=passed;internal=passed;public_https=passed;wss_handshake=passed;shared_ingress=passed;tcp80_closed=passed;running_digest=passed","final_observed_state":"current_digest=%s","approval":"not-required","executor":"%s","started_at":"%s","completed_at":"%s","outcome":"healthy"}\n' \
    "$source_commit" "$image" "$image_digest" "$workflow_run" \
    "$previous_digest" "$image_digest" "$executor" "$started_at" "$completed_at" >>"$history_file"
  fi
  if [[ "${COFORGE_INTERNAL_TEST_MODE:-}" == compose-release-tests ]] \
    && [[ "${COFORGE_TEST_FAIL_AFTER_COMMIT_AUDIT:-false}" == true ]]; then
    printf 'injected failure after commit audit\n' >&2
    exit 86
  fi
  rm -f -- "$pending_image_file" "$pending_previous_image_file" \
    "$pending_source_commit_file" "$pending_workflow_run_file" \
    "$pending_executor_file" "$pending_started_at_file" \
    "$pending_origin_file" "$pending_owner_file" "$pending_manual_from_file" \
    "$pending_prior_previous_image_file" "$pending_prior_previous_compose_file" \
    "$pending_prior_previous_compose_digest_file" \
    "$pending_previous_compose_file" "$pending_previous_compose_digest_file" \
    "$pending_rollback_complete_file" \
    "$pending_failure_file" "$rollback_compose_backup" \
    "$rollback_compose_backup_digest_file"
  printf 'image %s is healthy and committed\n' "$pending_image"
  exit 0
fi
if [[ "$release_image" == --finalize-rollback ]]; then
  if ! formal_pending_evidence_valid; then
    printf 'formal recovery evidence is incomplete or invalid\n' >&2
    exit 74
  fi
  require_pending_owner
  pending_image=$(cat "$pending_image_file" 2>/dev/null || true)
  pending_previous_image=$(cat "$pending_previous_image_file" 2>/dev/null || true)
  source_commit=$(cat "$pending_source_commit_file" 2>/dev/null || true)
  workflow_run=$(cat "$pending_workflow_run_file" 2>/dev/null || true)
  executor=$(cat "$pending_executor_file" 2>/dev/null || true)
  started_at=$(cat "$pending_started_at_file" 2>/dev/null || true)
  pending_origin=$(cat "$pending_origin_file" 2>/dev/null || true)
  pending_manual_from=$(cat "$pending_manual_from_file" 2>/dev/null || true)
  pending_prior_previous_image=$(cat "$pending_prior_previous_image_file" 2>/dev/null || true)
  failure_stage=$(cat "$pending_failure_file" 2>/dev/null || true)
  if [[ ! -e "$pending_rollback_complete_file" ]] \
    || [[ ! "$pending_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] \
    || [[ ! "$executor" =~ ^[A-Za-z0-9._@/-]+$ ]] \
    || [[ ! "$started_at" =~ ^[0-9TZ:.-]+$ ]] \
    || [[ ! "$pending_origin" =~ ^(release|manual)$ ]] \
    || [[ ! "$failure_stage" =~ ^(internal|external|interrupted|manual)$ ]]; then
    printf 'completed rollback evidence is missing or invalid (complete=%s image=%s source=%s run=%s executor=%s started=%s stage=%s)\n' \
      "$([[ -e "$pending_rollback_complete_file" ]] && printf yes || printf no)" \
      "$pending_image" "$source_commit" "$workflow_run" "$executor" \
      "$started_at" "$failure_stage" >&2
    exit 65
  fi
  if [[ "$pending_origin" == release ]] \
    && { [[ ! "$source_commit" =~ ^[0-9a-f]{40}$ ]] \
      || [[ ! "$workflow_run" =~ ^https://github\.com/[A-Za-z0-9._/-]+/actions/runs/[0-9]+$ ]]; }; then
    printf 'release rollback provenance is missing or invalid\n' >&2
    exit 65
  fi
  if [[ "$pending_origin" == manual ]] \
    && { [[ "$source_commit" != manual ]] || [[ "$workflow_run" != manual ]]; }; then
    printf 'manual rollback provenance is missing or invalid\n' >&2
    exit 65
  fi
  if [[ "$pending_previous_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    previous_digest=${pending_previous_image##*@}
  elif [[ "$pending_previous_image" == bootstrap:empty ]]; then
    previous_digest=bootstrap:empty
  else
    printf 'pending previous release evidence is invalid\n' >&2
    exit 65
  fi
  if [[ "${COFORGE_SHARED_INGRESS_HEALTH_RESULT:-}" != passed ]]; then
    printf 'rollback finalization requires passed shared-ingress evidence\n' >&2
    exit 65
  fi
  if [[ "${COFORGE_TCP80_RESULT:-}" != passed ]]; then
    printf 'rollback finalization requires passed TCP/80-closed evidence\n' >&2
    exit 65
  fi
  if [[ "$pending_previous_image" == bootstrap:empty ]]; then
    if [[ "${COFORGE_PUBLIC_HEALTH_RESULT:-}" != not-applicable ]] \
      || [[ "${COFORGE_WSS_HEALTH_RESULT:-}" != not-applicable ]] \
      || [[ "${COFORGE_RUNNING_DIGEST_RESULT:-}" != not-applicable ]]; then
      printf 'empty-state rollback requires explicit not-applicable public, WSS, and running-digest evidence\n' >&2
      exit 65
    fi
  elif [[ "${COFORGE_PUBLIC_HEALTH_RESULT:-}" != passed ]] \
    || [[ "${COFORGE_WSS_HEALTH_RESULT:-}" != passed ]] \
    || [[ "${COFORGE_RUNNING_DIGEST_RESULT:-}" != passed ]]; then
    printf 'rollback finalization requires passed public, WSS, and running-digest evidence\n' >&2
    exit 65
  fi
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  image=${pending_image%@*}
  image_digest=${pending_image##*@}
  next_rollback_image=$pending_prior_previous_image
  if [[ "$pending_origin" == manual ]]; then
    if [[ "$pending_manual_from" == bootstrap:empty ]]; then
      next_rollback_image=bootstrap:empty
    else
      next_rollback_image=$pending_image
    fi
  fi
  if [[ "$next_rollback_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    next_rollback_digest=${next_rollback_image##*@}
  else
    next_rollback_digest=bootstrap:empty
  fi
  if [[ "$pending_origin" == manual ]]; then
    if [[ "$pending_manual_from" == bootstrap:empty ]]; then
      write_release_state "$pending_previous_image" bootstrap:empty \
        "$compose_file" "$app_root/.empty-compose"
    else
      manual_current_compose=$compose_file
      if [[ "$pending_previous_image" == bootstrap:empty ]]; then
        manual_current_compose="$app_root/.empty-compose"
      fi
      write_release_state "$pending_previous_image" "$pending_image" \
        "$manual_current_compose" "$rollback_compose_backup"
    fi
  else
    if [[ ! "$pending_prior_previous_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
      pending_prior_previous_image=bootstrap:empty
    fi
    rollback_current_compose=$compose_file
    if [[ "$pending_previous_image" == bootstrap:empty ]]; then
      rollback_current_compose="$app_root/.empty-compose"
    fi
    write_release_state "$pending_previous_image" "$pending_prior_previous_image" \
      "$rollback_current_compose" "$pending_prior_previous_compose_file"
  fi
  printf '{"source_commit":"%s","track":"cloud-application","image":"%s","image_digest":"%s","environment":"test","workflow_run":"%s","previous_digest":"%s","health_result":"candidate_%s=failed;rollback_container=%s;rollback_internal=%s;rollback_public_https=%s;rollback_wss_handshake=%s;shared_ingress=passed;tcp80_closed=passed;running_digest=%s","final_observed_state":"current_digest=%s","next_rollback_digest":"%s","approval":"not-required","executor":"%s","started_at":"%s","completed_at":"%s","outcome":"rolled_back"}\n' \
    "$source_commit" "$image" "$image_digest" "$workflow_run" \
    "$previous_digest" "$failure_stage" \
    "${COFORGE_RUNNING_DIGEST_RESULT:-}" "${COFORGE_RUNNING_DIGEST_RESULT:-}" \
    "${COFORGE_PUBLIC_HEALTH_RESULT:-}" "${COFORGE_WSS_HEALTH_RESULT:-}" \
    "${COFORGE_RUNNING_DIGEST_RESULT:-}" \
    "$previous_digest" "$next_rollback_digest" \
    "$executor" "$started_at" "$completed_at" >>"$history_file"
  rm -f -- "$pending_image_file" "$pending_previous_image_file" \
    "$pending_source_commit_file" "$pending_workflow_run_file" \
    "$pending_executor_file" "$pending_started_at_file" \
    "$pending_origin_file" "$pending_owner_file" "$pending_manual_from_file" \
    "$pending_prior_previous_image_file" "$pending_prior_previous_compose_file" \
    "$pending_prior_previous_compose_digest_file" \
    "$pending_previous_compose_file" "$pending_previous_compose_digest_file" \
    "$pending_rollback_complete_file" \
    "$pending_failure_file" "$rollback_compose_backup" \
    "$rollback_compose_backup_digest_file"
  printf 'failed candidate %s was rolled back and verified\n' "$pending_image"
  exit 0
fi
if [[ "$release_image" == --record-failed-rollback ]]; then
  require_pending_owner
  pending_image=$(cat "$pending_image_file" 2>/dev/null || true)
  pending_previous_image=$(cat "$pending_previous_image_file" 2>/dev/null || true)
  source_commit=$(cat "$pending_source_commit_file" 2>/dev/null || true)
  workflow_run=$(cat "$pending_workflow_run_file" 2>/dev/null || true)
  executor=$(cat "$pending_executor_file" 2>/dev/null || true)
  started_at=$(cat "$pending_started_at_file" 2>/dev/null || true)
  pending_origin=$(cat "$pending_origin_file" 2>/dev/null || true)
  failure_stage=$(cat "$pending_failure_file" 2>/dev/null || true)
  if [[ ! "$pending_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] \
    || [[ ! "$executor" =~ ^[A-Za-z0-9._@/-]+$ ]] \
    || [[ ! "$started_at" =~ ^[0-9TZ:.-]+$ ]] \
    || [[ ! "$pending_origin" =~ ^(release|manual)$ ]] \
    || [[ ! "$failure_stage" =~ ^(internal|external|interrupted|manual)$ ]]; then
    printf 'failed rollback evidence is missing or invalid\n' >&2
    exit 65
  fi
  if [[ "$pending_origin" == release ]] \
    && { [[ ! "$source_commit" =~ ^[0-9a-f]{40}$ ]] \
      || [[ ! "$workflow_run" =~ ^https://github\.com/[A-Za-z0-9._/-]+/actions/runs/[0-9]+$ ]]; }; then
    printf 'release rollback provenance is missing or invalid\n' >&2
    exit 65
  fi
  if [[ "$pending_origin" == manual ]] \
    && { [[ "$source_commit" != manual ]] || [[ "$workflow_run" != manual ]]; }; then
    printf 'manual rollback provenance is missing or invalid\n' >&2
    exit 65
  fi
  if [[ "$pending_previous_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    previous_digest=${pending_previous_image##*@}
  elif [[ "$pending_previous_image" == bootstrap:empty ]]; then
    previous_digest=bootstrap:empty
  else
    printf 'pending previous release evidence is invalid\n' >&2
    exit 65
  fi
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  image=${pending_image%@*}
  image_digest=${pending_image##*@}
  observed_selected=$previous_image
  if [[ "$observed_selected" != bootstrap:empty ]] \
    && [[ ! "$observed_selected" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    observed_selected=unknown
  fi
  observed_next_rollback=$recorded_previous_image
  if [[ "$observed_next_rollback" == bootstrap:empty ]]; then
    next_rollback_digest=bootstrap:empty
  elif [[ "$observed_next_rollback" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    next_rollback_digest=${observed_next_rollback##*@}
  else
    next_rollback_digest=unknown
  fi
  observed_compatibility=$(cat "$current_image_file" 2>/dev/null || true)
  if [[ ! "$observed_compatibility" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    observed_compatibility=absent
  fi
  probe_image=$pending_image
  if [[ "$observed_selected" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    probe_image=$observed_selected
  fi
  docker_status=unavailable
  observed_running=unknown
  gateway_container=unknown
  if docker info >/dev/null 2>&1; then
    docker_status=available
    container_id=$(COFORGE_GATEWAY_IMAGE="$probe_image" docker compose \
      --project-name "$project_name" --file "$compose_file" \
      ps --all --quiet gateway 2>/dev/null || true)
    observed_running=absent
    gateway_container=absent
    if [[ -n "$container_id" ]]; then
      gateway_container=present
      observed_running=$(docker inspect --format '{{.Config.Image}}' "$container_id" 2>/dev/null || true)
      if [[ ! "$observed_running" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
        observed_running=unknown
      fi
    fi
  fi
  printf '{"source_commit":"%s","track":"cloud-application","image":"%s","image_digest":"%s","environment":"test","workflow_run":"%s","previous_digest":"%s","health_result":"candidate_%s=failed;rollback=failed","final_observed_state":"docker=%s;selected_image=%s;compatibility_current=%s;running_image=%s;gateway_container=%s","next_rollback_digest":"%s","approval":"not-required","executor":"%s","started_at":"%s","completed_at":"%s","outcome":"failed_rollback"}\n' \
    "$source_commit" "$image" "$image_digest" "$workflow_run" \
    "$previous_digest" "$failure_stage" "$docker_status" "$observed_selected" \
    "$observed_compatibility" "$observed_running" "$gateway_container" \
    "$next_rollback_digest" "$executor" "$started_at" "$completed_at" >>"$history_file"
  rm -f -- "$pre_marker_active_file"
  printf 'failed rollback was recorded; pending recovery evidence was retained\n'
  exit 0
fi
if [[ "$release_image" == --rollback ]]; then
  rollback=true
  pending_image=$(cat "$pending_image_file" 2>/dev/null || true)
  pending_previous_image=$(cat "$pending_previous_image_file" 2>/dev/null || true)
  if [[ -e "$pending_image_file" ]] \
    && [[ ! "$pending_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    printf 'pending release evidence is corrupt; refusing rollback mutation\n' >&2
    exit 65
  fi
  if [[ "$pending_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    if ! formal_pending_evidence_valid; then
      printf 'formal recovery evidence is incomplete or invalid\n' >&2
      exit 74
    fi
    require_pending_owner
    : >"$pre_marker_active_file"
    release_image=$pending_previous_image
    pending_rollback=true
    if [[ ! -e "$pending_failure_file" ]]; then
      printf 'external\n' >"$pending_failure_file"
    fi
    if [[ "$release_image" == bootstrap:empty ]]; then
      export COFORGE_GATEWAY_IMAGE=$pending_image
      if ! docker compose \
        --project-name "$project_name" \
        --file "$compose_file" \
        down; then
        printf 'failed bootstrap candidate %s could not be stopped\n' \
          "$pending_image" >&2
        exit 1
      fi
      remaining_container=$(docker compose \
        --project-name "$project_name" \
        --file "$compose_file" \
        ps --all --quiet)
      if [[ -n "$remaining_container" ]]; then
        printf 'failed bootstrap candidate %s is still present after shutdown\n' \
          "$pending_image" >&2
        exit 1
      fi
      rm -f -- "$current_image_file"
      : >"$pending_rollback_complete_file"
      rm -f -- "$pre_marker_active_file"
      printf 'failed bootstrap candidate %s was stopped\n' "$pending_image"
      exit 0
    fi
    if [[ -r "$pending_previous_compose_file" ]]; then
      cp -f "$pending_previous_compose_file" "$compose_file"
    fi
  else
    release_image=$recorded_previous_image
    pending_rollback=false
    manual_pending_image=$previous_image
    manual_from=
    if [[ "$previous_image" == bootstrap:empty ]] \
      && [[ "$release_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
      manual_pending_image=$release_image
      manual_from=bootstrap:empty
    elif [[ ! "$previous_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
      printf 'current release evidence is missing or invalid\n' >&2
      exit 65
    fi
    if [[ ! "$release_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
      release_image=bootstrap:empty
    fi
    manual_executor=${COFORGE_EXECUTOR:-local}
    manual_owner=${COFORGE_TRANSACTION_OWNER:-manual}
    if [[ ! "$manual_executor" =~ ^[A-Za-z0-9._@/-]+$ ]] \
      || [[ ! "$manual_owner" =~ ^[A-Za-z0-9._-]+$ ]]; then
      printf 'manual rollback requires valid executor and owner identities\n' >&2
      exit 64
    fi
    started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    pre_marker_image=$manual_pending_image
    pre_marker_previous=$release_image
    pre_marker_source_commit=manual
    pre_marker_workflow_run=manual
    pre_marker_executor=$manual_executor
    pre_marker_started_at=$started_at
    trap 'record_pre_marker_interruption HUP' HUP
    trap 'record_pre_marker_interruption INT' INT
    trap 'record_pre_marker_interruption TERM' TERM
    : >"$pre_marker_active_file"
    if [[ -n "$manual_from" ]]; then
      printf '%s\n' "$manual_from" >"$pending_manual_from_file"
    fi
    printf '%s\n' "$release_image" >"$pending_previous_image_file"
    if [[ "$release_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
      if [[ ! -r "$previous_compose_source" ]]; then
        clear_pending
        printf 'previous release record has no readable Compose definition\n' >&2
        exit 65
      fi
      cp -f "$previous_compose_source" "$pending_previous_compose_file"
      sha256sum "$pending_previous_compose_file" | cut -d ' ' -f 1 \
        >"$pending_previous_compose_digest_file"
    else
      printf 'none\n' >"$pending_previous_compose_digest_file"
    fi
    printf 'manual\n' >"$pending_source_commit_file"
    printf 'manual\n' >"$pending_workflow_run_file"
    printf '%s\n' "$manual_executor" >"$pending_executor_file"
    printf '%s\n' "$started_at" >"$pending_started_at_file"
    printf 'manual\n' >"$pending_origin_file"
    printf '%s\n' "$manual_owner" >"$pending_owner_file"
    printf 'manual\n' >"$pending_failure_file"
    pending_image=$manual_pending_image
    pending_previous_image=$release_image
    if [[ "$previous_image" != bootstrap:empty ]]; then
      if [[ ! -r "$current_compose_source" ]]; then
        clear_pending
        printf 'current release record has no readable Compose definition\n' >&2
        exit 65
      fi
      cp -f "$current_compose_source" "$rollback_compose_backup"
      sha256sum "$rollback_compose_backup" | cut -d ' ' -f 1 \
        >"$rollback_compose_backup_digest_file"
      if [[ "$current_compose_source" != "$compose_file" ]]; then
        cp -f "$current_compose_source" "$compose_file"
      fi
    else
      printf 'none\n' >"$rollback_compose_backup_digest_file"
    fi
    printf '%s\n' "$manual_pending_image" >"$next_pending_image_file"
    mv -f "$next_pending_image_file" "$pending_image_file"
    trap 'record_interruption HUP' HUP
    trap 'record_interruption INT' INT
    trap 'record_interruption TERM' TERM
    if [[ "${COFORGE_INTERNAL_TEST_MODE:-}" == compose-release-tests ]] \
      && [[ "${COFORGE_TEST_SIGNAL_DURING_ACTIVE_REMOVAL:-false}" == true ]]; then
      kill -TERM "$$"
    fi
  fi
  if [[ ! "$release_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] \
    && [[ "$previous_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    export COFORGE_GATEWAY_IMAGE=$previous_image
    if ! docker compose \
      --project-name "$project_name" \
      --file "$compose_file" \
      down; then
      record_standalone_rollback "$previous_image" "${previous_image##*@}" \
        'rollback_empty=failed' failed_rollback bootstrap:empty
      printf 'current image %s could not be stopped\n' "$previous_image" >&2
      exit 1
    fi
    remaining_container=$(docker compose \
      --project-name "$project_name" \
      --file "$compose_file" \
      ps --all --quiet)
    if [[ -n "$remaining_container" ]]; then
      record_standalone_rollback "$previous_image" "${previous_image##*@}" \
        'rollback_empty=failed;gateway_container=present' failed_rollback \
        bootstrap:empty
      printf 'Compose project is not empty after rollback shutdown\n' >&2
      exit 1
    fi
    : >"$pending_rollback_complete_file"
    rm -f -- "$pre_marker_active_file"
    printf 'current image %s was stopped and is pending external verification\n' \
      "$previous_image"
    exit 0
  fi
fi
if [[ ! "$release_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
  printf 'image must be an immutable ghcr.io reference pinned by sha256 digest\n' >&2
  exit 64
fi
if [[ "$rollback" == false ]] && [[ -e "$pending_image_file" ]]; then
  record_orphaned_pending
  printf 'another release is already pending external verification\n' >&2
  exit 75
fi
defer_commit=${COFORGE_DEFER_COMMIT:-false}
if [[ "$defer_commit" != false ]] && [[ "$defer_commit" != true ]]; then
  printf 'COFORGE_DEFER_COMMIT must be true or false\n' >&2
  exit 64
fi
if [[ "$rollback" == false ]] && [[ "$defer_commit" != true ]] \
  && { [[ "${COFORGE_INTERNAL_TEST_MODE:-}" != compose-release-tests ]] \
    || [[ "$app_root" != /tmp/* ]]; }; then
  printf 'image deployment requires deferred external verification\n' >&2
  exit 64
fi
if [[ "$defer_commit" == true ]]; then
  source_commit=${COFORGE_SOURCE_COMMIT:-}
  workflow_run=${COFORGE_WORKFLOW_RUN:-}
  executor=${COFORGE_EXECUTOR:-}
  transaction_owner=${COFORGE_TRANSACTION_OWNER:-}
  if [[ ! "$source_commit" =~ ^[0-9a-f]{40}$ ]] \
    || [[ ! "$workflow_run" =~ ^https://github\.com/[A-Za-z0-9._/-]+/actions/runs/[0-9]+$ ]] \
    || [[ ! "$executor" =~ ^[A-Za-z0-9._@/-]+$ ]] \
    || [[ ! "$transaction_owner" =~ ^[A-Za-z0-9._-]+$ ]]; then
    printf 'deferred commit requires valid source commit, workflow run, and executor evidence\n' >&2
    exit 64
  fi
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  pre_marker_image=$release_image
  pre_marker_previous=$previous_image
  if [[ ! "$pre_marker_previous" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    pre_marker_previous=bootstrap:empty
  fi
  pre_marker_source_commit=$source_commit
  pre_marker_workflow_run=$workflow_run
  pre_marker_executor=$executor
  pre_marker_started_at=$started_at
  trap 'record_pre_marker_interruption HUP' HUP
  trap 'record_pre_marker_interruption INT' INT
  trap 'record_pre_marker_interruption TERM' TERM
  : >"$pre_marker_active_file"
  if [[ "$previous_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    printf '%s\n' "$previous_image" >"$pending_previous_image_file"
    if [[ ! -r "$current_compose_source" ]]; then
      record_failed_preparation missing-current-compose
      printf 'current release record has no readable Compose definition\n' >&2
      exit 65
    fi
    cp -f "$current_compose_source" "$pending_previous_compose_file"
    sha256sum "$pending_previous_compose_file" | cut -d ' ' -f 1 \
      >"$pending_previous_compose_digest_file"
  else
    printf 'bootstrap:empty\n' >"$pending_previous_image_file"
    printf 'none\n' >"$pending_previous_compose_digest_file"
  fi
  if [[ "$recorded_previous_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    printf '%s\n' "$recorded_previous_image" >"$pending_prior_previous_image_file"
    if [[ ! -r "$previous_compose_source" ]]; then
      record_failed_preparation missing-prior-compose
      printf 'prior release record has no readable Compose definition\n' >&2
      exit 65
    fi
    cp -f "$previous_compose_source" "$pending_prior_previous_compose_file"
    sha256sum "$pending_prior_previous_compose_file" | cut -d ' ' -f 1 \
      >"$pending_prior_previous_compose_digest_file"
  else
    printf 'bootstrap:empty\n' >"$pending_prior_previous_image_file"
    printf 'none\n' >"$pending_prior_previous_compose_digest_file"
  fi
  printf '%s\n' "$source_commit" >"$pending_source_commit_file"
  printf '%s\n' "$workflow_run" >"$pending_workflow_run_file"
  printf '%s\n' "$executor" >"$pending_executor_file"
  printf '%s\n' "$started_at" >"$pending_started_at_file"
  printf 'release\n' >"$pending_origin_file"
  printf '%s\n' "$transaction_owner" >"$pending_owner_file"
  printf '%s\n' "$release_image" >"$next_pending_image_file"
  mv -f "$next_pending_image_file" "$pending_image_file"
  trap 'record_interruption HUP' HUP
  trap 'record_interruption INT' INT
  trap 'record_interruption TERM' TERM
  if [[ "${COFORGE_INTERNAL_TEST_MODE:-}" == compose-release-tests ]] \
    && [[ "${COFORGE_TEST_SIGNAL_DURING_ACTIVE_REMOVAL:-false}" == true ]]; then
    kill -TERM "$$"
  fi
fi
if [[ "$rollback" == false ]]; then
  export COFORGE_GATEWAY_IMAGE=$release_image
  if ! docker compose \
    --project-name "$project_name" \
    --file "$candidate_compose_file" \
    config --quiet; then
    if [[ "$defer_commit" == true ]]; then
      record_failed_preparation compose-validation
    fi
    printf 'candidate Compose definition failed validation\n' >&2
    exit 65
  fi
  if [[ ! "$previous_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    if [[ -e "$current_image_file" ]]; then
      if [[ "$defer_commit" == true ]]; then
        record_failed_preparation invalid-current-record
      fi
      printf 'current release record is invalid; refusing bootstrap\n' >&2
      exit 65
    fi
    existing_container=$(docker compose \
      --project-name "$project_name" \
      --file "$candidate_compose_file" \
      ps --all --quiet)
    if [[ -n "$existing_container" ]]; then
      if [[ "$defer_commit" == true ]]; then
        record_failed_preparation nonempty-bootstrap
      fi
      printf 'release record is missing but the Compose project is not empty\n' >&2
      exit 65
    fi
  elif [[ ! -r "$compose_file" ]]; then
    if [[ "$defer_commit" == true ]]; then
      record_failed_preparation missing-current-compose
    fi
    printf 'current release record has no readable Compose definition\n' >&2
    exit 65
  fi
  if [[ "$candidate_compose_file" != "$compose_file" ]]; then
    if [[ -r "$compose_file" ]]; then
      if [[ "$defer_commit" == false ]]; then
        cp -f "$compose_file" "$previous_compose_file"
      fi
    fi
    install -m 0600 "$candidate_compose_file" "$compose_file"
  fi
fi
if [[ "$rollback" == true ]] && [[ "${pending_rollback:-false}" == false ]]; then
  if [[ "$previous_image" != bootstrap:empty ]] && [[ -r "$compose_file" ]]; then
    cp -f "$compose_file" "$rollback_compose_backup"
  fi
  if [[ "$release_image" != bootstrap:empty ]]; then
    if [[ ! -r "$previous_compose_source" ]]; then
      printf 'previous Compose definition is missing\n' >&2
      exit 65
    fi
    cp -f "$previous_compose_source" "$compose_file"
  fi
fi

deploy_image() {
  local image=$1
  if [[ "${COFORGE_INTERNAL_TEST_MODE:-}" == compose-release-tests ]] \
    && [[ "${COFORGE_TEST_SIGNAL_READONLY_DURING_PULL:-false}" == true ]]; then
    chmod 0500 "$app_root"
    kill -TERM "$$"
  fi
  export COFORGE_GATEWAY_IMAGE=$image

  docker compose \
    --project-name "$project_name" \
    --file "$compose_file" \
    pull gateway || return
  docker compose \
    --project-name "$project_name" \
    --file "$compose_file" \
    up --detach --wait --wait-timeout 60 --no-build gateway || return

  local container_id running_image
  container_id=$(docker compose \
    --project-name "$project_name" \
    --file "$compose_file" \
    ps --quiet gateway)
  if [[ -z "$container_id" ]]; then
    return 1
  fi
  running_image=$(docker inspect --format '{{.Config.Image}}' "$container_id")
  if [[ "$running_image" != "$image" ]]; then
    printf 'running container image %s does not match requested image %s\n' \
      "$running_image" "$image" >&2
    return 1
  fi

  local attempt
  for ((attempt = 1; attempt <= health_attempts; attempt++)); do
    if curl --fail --silent --show-error --max-time 3 "$health_url" >/dev/null; then
      return 0
    fi
    if ((attempt < health_attempts)); then
      sleep 1
    fi
  done
  return 1
}

stop_project_and_verify_empty() {
  local image=$1
  local remaining_container
  export COFORGE_GATEWAY_IMAGE=$image
  docker compose \
    --project-name "$project_name" \
    --file "$compose_file" \
    down || return
  remaining_container=$(docker compose \
    --project-name "$project_name" \
    --file "$compose_file" \
    ps --all --quiet) || return
  [[ -z "$remaining_container" ]]
}

if deploy_image "$release_image"; then
  if [[ "$rollback" == true ]]; then
    : >"$pending_rollback_complete_file"
    rm -f -- "$pre_marker_active_file"
    printf 'rollback image %s passed internal health and is pending external verification\n' \
      "$release_image"
    exit 0
  fi
  if [[ "$defer_commit" == true ]]; then
    rm -f -- "$pre_marker_active_file"
    printf 'image %s passed internal health and is pending external verification\n' \
      "$release_image"
    exit 0
  fi
  if [[ ! "$previous_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    previous_image=bootstrap:empty
  fi
  write_release_state "$release_image" "$previous_image" \
    "$compose_file" "$previous_compose_source"
  printf 'image %s is healthy\n' "$release_image"
  exit 0
fi

printf 'image %s failed its health check; restoring previous image\n' "$release_image" >&2
if [[ "$defer_commit" == true ]]; then
  printf 'internal\n' >"$pending_failure_file"
  pending_previous_image=$(cat "$pending_previous_image_file")
  if [[ "$pending_previous_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    cp -f "$pending_previous_compose_file" "$compose_file"
    if ! deploy_image "$pending_previous_image"; then
      printf 'previous image %s also failed health verification\n' \
        "$pending_previous_image" >&2
      exit 1
    fi
    printf '%s\n' "$pending_previous_image" >"$next_image_file"
    mv -f "$next_image_file" "$current_image_file"
  else
    if ! stop_project_and_verify_empty "$release_image"; then
      printf 'failed bootstrap candidate %s could not be restored to an empty state\n' \
        "$release_image" >&2
      exit 1
    fi
    rm -f -- "$current_image_file"
  fi
  : >"$pending_rollback_complete_file"
  rm -f -- "$pre_marker_active_file"
  exit 1
fi
if [[ "$rollback" == true ]] && [[ -r "$rollback_compose_backup" ]]; then
  cp -f "$rollback_compose_backup" "$compose_file"
fi
if [[ "$previous_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
  if [[ "$rollback" == false ]] && [[ -r "$previous_compose_source" ]]; then
    cp -f "$previous_compose_source" "$compose_file"
  fi
  if ! deploy_image "$previous_image"; then
    printf 'previous image %s also failed health verification\n' "$previous_image" >&2
    exit 1
  fi
else
  if ! stop_project_and_verify_empty "$release_image"; then
    printf 'failed candidate %s could not be restored to an empty state\n' \
      "$release_image" >&2
    exit 1
  fi
fi
exit 1
