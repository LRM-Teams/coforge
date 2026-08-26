#!/usr/bin/env bash

set -euo pipefail

: "${ECS_EDGE_BIND_IP:?ECS_EDGE_BIND_IP is required}"
: "${ECS_HOST:?ECS_HOST is required}"
: "${ECS_SHARED_INGRESS_HEALTH_PATH:?ECS_SHARED_INGRESS_HEALTH_PATH is required}"
: "${IMAGE_REF:?IMAGE_REF is required}"
: "${TRANSACTION_OWNER:?TRANSACTION_OWNER is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

ssh_config="$RUNNER_TEMP/ssh/config"
pending_root=.local/share/coforge/realtime-gateway

pending_state=$(ssh -F "$ssh_config" coforge-ecs \
  "if test -e $pending_root/pending-image; then printf present; else printf absent; fi")
case "$pending_state" in
  absent)
    exit 0
    ;;
  present)
    ;;
  *)
    printf 'remote pending-state probe returned an invalid result\n' >&2
    exit 1
    ;;
esac

pending_owner=$(ssh -F "$ssh_config" coforge-ecs \
  "cat $pending_root/pending-owner")
if [[ "$pending_owner" != "$TRANSACTION_OWNER" ]]; then
  ssh -F "$ssh_config" coforge-ecs \
    "COFORGE_TRANSACTION_OWNER='$TRANSACTION_OWNER' \
      $pending_root/compose_release.sh --adopt-interrupted"
fi
set +e
ssh -F "$ssh_config" coforge-ecs \
  "COFORGE_TRANSACTION_OWNER='$TRANSACTION_OWNER' \
    $pending_root/compose_release.sh --record-interruption"
interruption_status=$?
set -e
if [[ "$interruption_status" -ne 130 ]]; then
  printf 'interrupted release audit failed with status %s\n' \
    "$interruption_status" >&2
  exit 1
fi

recovery_ok=true
if ! ssh -F "$ssh_config" coforge-ecs \
  "COFORGE_EDGE_BIND_IP='$ECS_EDGE_BIND_IP' \
    COFORGE_TRANSACTION_OWNER='$TRANSACTION_OWNER' \
    $pending_root/compose_release.sh --rollback"; then
  recovery_ok=false
fi
rollback_image=$(ssh -F "$ssh_config" coforge-ecs \
  "COFORGE_TRANSACTION_OWNER='$TRANSACTION_OWNER' \
    $pending_root/compose_release.sh --rollback-target-image") \
  || recovery_ok=false
curl --fail --silent --show-error --noproxy '*' --proto '=https' \
  --tlsv1.2 --connect-timeout 5 --max-time 20 \
  "https://$ECS_HOST$ECS_SHARED_INGRESS_HEALTH_PATH" >/dev/null \
  || recovery_ok=false
python3 scripts/deploy/tcp_closed.py "$ECS_HOST" 80 --timeout 5 \
  || recovery_ok=false

rollback_evidence=passed
if [[ -n "$rollback_image" ]]; then
  curl --fail --silent --show-error --noproxy '*' --proto '=https' \
    --tlsv1.2 --connect-timeout 5 --max-time 20 \
    "https://$ECS_HOST/coforge/readyz" >/dev/null \
    || recovery_ok=false
  python3 scripts/deploy/wss_smoke.py \
    "wss://$ECS_HOST/coforge/v1/connect" --timeout 10 \
    || recovery_ok=false
  running=$(ssh -F "$ssh_config" coforge-ecs \
    "export XDG_RUNTIME_DIR=/run/user/\$(id -u); \
      export DOCKER_HOST=unix://\$XDG_RUNTIME_DIR/docker.sock; \
      container=\$(COFORGE_GATEWAY_IMAGE='$rollback_image' docker compose \
        --project-name coforge-test --file $pending_root/compose.yaml \
        ps --quiet gateway); \
      test -n \"\$container\"; \
      docker inspect --format '{{.Config.Image}}' \"\$container\"") \
    || recovery_ok=false
  [[ "$running" == "$rollback_image" ]] || recovery_ok=false
else
  rollback_evidence=not-applicable
  containers=$(ssh -F "$ssh_config" coforge-ecs \
    "export XDG_RUNTIME_DIR=/run/user/\$(id -u); \
      export DOCKER_HOST=unix://\$XDG_RUNTIME_DIR/docker.sock; \
      COFORGE_GATEWAY_IMAGE='$IMAGE_REF' docker compose \
      --project-name coforge-test --file $pending_root/compose.yaml \
      ps --all --quiet") || recovery_ok=false
  [[ -z "$containers" ]] || recovery_ok=false
fi

if [[ "$recovery_ok" == true ]] && ssh -F "$ssh_config" coforge-ecs \
  "COFORGE_PUBLIC_HEALTH_RESULT='$rollback_evidence' \
    COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
    COFORGE_WSS_HEALTH_RESULT='$rollback_evidence' \
    COFORGE_TCP80_RESULT=passed \
    COFORGE_RUNNING_DIGEST_RESULT='$rollback_evidence' \
    COFORGE_TRANSACTION_OWNER='$TRANSACTION_OWNER' \
    $pending_root/compose_release.sh --finalize-rollback"; then
  exit 0
fi

ssh -F "$ssh_config" coforge-ecs \
  "COFORGE_TRANSACTION_OWNER='$TRANSACTION_OWNER' \
    $pending_root/compose_release.sh --record-failed-rollback"
exit 1
