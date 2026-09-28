#!/bin/bash
# Generic evolbench-collab shard launcher.
# usage: evol-shard.sh <name> <manifest> <evalId> <arms> [families-comma] [mod] [extra env...]
NAME=$1; MANIFEST=$2; EVALID=$3; ARMS=$4; FAMILIES=$5; MOD=$6; shift 6 || true
cd /home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl
export PATH="$HOME/.local/share/mise/installs/bun/1.4.2/bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
export NODE_EXTRA_CA_CERTS="$HOME/.pi/lenovo-ca-bundle.pem"
set -a
eval "$(grep -E '^(DATABASE_URL|REDIS_URL|COFORGE_CENTRIFUGO_API_URL|COFORGE_CENTRIFUGO_API_KEY|COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY)=' /home/zhoujie22/river2_0/coforge/apps/web/.env)"
set +a
export COFORGE_EVOLBENCH_COLLAB_EVAL=1
export COFORGE_WEB_URL=http://127.0.0.1:18888
export OPENVIKING_PROTOTYPE_ENABLED=1
export COFORGE_OPENVIKING_URL=http://127.0.0.1:1933
export COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE=/tmp/pcm-eval-ov-keys.json
export COFORGE_EVAL_RESUME=1
export COFORGE_EVAL_MANIFEST=$MANIFEST
export COFORGE_EVALUATION_ID=$EVALID
export COFORGE_EVAL_ARMS=$ARMS
[ -n "$FAMILIES" ] && [ "$FAMILIES" != "-" ] && export COFORGE_EVAL_FAMILIES=$FAMILIES
[ -n "$MOD" ] && [ "$MOD" != "-" ] && export COFORGE_EVAL_EPISODE_MOD=$MOD
for kv in "$@"; do export "$kv"; done
LOG=/tmp/shard-$NAME.log
while true; do
  setsid mise exec -- bun benchmark/evolbench-collab/src/run.ts >> "$LOG" 2>&1 &
  RUNNER=$!
  LINES=$(wc -l < "$LOG" 2>/dev/null || echo 0)
  while kill -0 $RUNNER 2>/dev/null; do
    sleep 90
    kill -0 $RUNNER 2>/dev/null || break
    NEW=$(wc -l < "$LOG" 2>/dev/null || echo 0)
    if grep -q "wrote .*$EVALID-summary" "$LOG" 2>/dev/null; then
      sleep 15; kill -9 -- -$RUNNER 2>/dev/null; echo "[shard-$NAME] DONE" >> "$LOG"; exit 0
    fi
    if [ "$NEW" -gt "$LINES" ]; then
      LINES=$NEW; LASTGROW=$(date +%s)
    fi
    # Provisioning (OV account + workspace + daemon + agent start) has quiet
    # phases well over a minute under load; only a 15-minute silence counts
    # as a real stall.
    if [ $(( $(date +%s) - ${LASTGROW:-$(date +%s)} )) -gt 900 ]; then
      echo "[shard-$NAME] silent for >15min, killing for resume" >> "$LOG"
      kill -9 -- -$RUNNER 2>/dev/null
      break
    fi
  done
  wait $RUNNER 2>/dev/null
  if grep -q "wrote .*$EVALID-summary" "$LOG" 2>/dev/null; then
    kill -9 -- -$RUNNER 2>/dev/null; echo "[shard-$NAME] DONE (post)" >> "$LOG"; exit 0
  fi
  sleep 20
done
