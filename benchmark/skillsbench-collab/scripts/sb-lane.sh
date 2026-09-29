#!/bin/bash
# skillsbench-collab lane L of N (static task split by index mod N).
# FIX 2026-09-25: runner task selection comes from COFORGE_EVAL_TASKS; without it
# every invocation silently ran the first task (3d-scan-calc) only.
LANE=$1
LANES=${2:-3}
cd /home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl
export PATH="$HOME/.local/share/mise/installs/bun/1.4.2/bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
export NODE_EXTRA_CA_CERTS="$HOME/.pi/lenovo-ca-bundle.pem"
set -a
eval "$(grep -E '^(DATABASE_URL|REDIS_URL|COFORGE_CENTRIFUGO_API_URL|COFORGE_CENTRIFUGO_API_KEY|COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY)=' /home/zhoujie22/river2_0/coforge/apps/web/.env)"
. /tmp/pcm-cursor-api-key.env 2>/dev/null
set +a
export COFORGE_SKILLSBENCH_COLLAB_EVAL=1
export COFORGE_WEB_URL=http://127.0.0.1:18888
export OPENVIKING_PROTOTYPE_ENABLED=1
export COFORGE_OPENVIKING_URL=http://127.0.0.1:1933
export COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE=/tmp/pcm-eval-ov-keys.json
RESULT_DIR=benchmark/skillsbench-collab/result
LOG=/tmp/sb-lane$LANE.log
# this lane's tasks: index % LANES == LANE
TASKS=$(ls benchmark/skillsbench-collab/bench_data/tasks | sort | awk -v l=$LANE -v n=$LANES 'NR%n==l')
echo "[lane$LANE] $(echo "$TASKS" | wc -l) tasks (mod $LANES)" >> "$LOG"
for TASK in $TASKS; do
  if grep -l "\"taskName\":\"$TASK\"" $RESULT_DIR/attempts-*.jsonl >/dev/null 2>&1; then
    echo "[lane$LANE] skip $TASK" >> "$LOG"
    continue
  fi
  echo "[lane$LANE] $(date -u +%H:%M:%S) starting $TASK" >> "$LOG"
  COFORGE_EVAL_TASKS="$TASK" setsid mise exec -- bun benchmark/skillsbench-collab/src/run.ts >> /tmp/sb-eval-$TASK.log 2>&1 &
  PID=$!
  DEADLINE=$(( $(date +%s) + 4500 ))
  while kill -0 $PID 2>/dev/null; do
    sleep 20
    if grep -q "\"taskName\":\"$TASK\"" $RESULT_DIR/attempts-*.jsonl 2>/dev/null; then
      sleep 15; kill -9 -- -$PID 2>/dev/null; break
    fi
    if [ "$(date +%s)" -gt "$DEADLINE" ]; then
      echo "[lane$LANE] $TASK timed out" >> "$LOG"
      kill -9 -- -$PID 2>/dev/null; sleep 5
      # scoped cleanup: only THIS task's workspaces (slug sb-collab-<arm>-<task>-<rand8>)
      cd /home/zhoujie22/river2_0/coforge/apps/web
      DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-) psql "$DATABASE_URL" -c "DELETE FROM workspaces WHERE slug LIKE 'sb-collab-%-$TASK-________';" >/dev/null 2>&1
      cd /home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl
      break
    fi
  done
  wait $PID 2>/dev/null
  echo "[lane$LANE] $(date -u +%H:%M:%S) $TASK done" >> "$LOG"
done
echo "[lane$LANE] LANE DONE" >> "$LOG"
