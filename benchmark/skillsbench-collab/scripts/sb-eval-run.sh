#!/bin/bash
# skillsbench-collab smoke/eval launcher. Usage: /tmp/sb-eval-run.sh [TASK_NAME]
cd /home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl
export PATH="$HOME/.local/share/mise/installs/bun/1.4.2/bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
export NODE_EXTRA_CA_CERTS="$HOME/.pi/lenovo-ca-bundle.pem"
set -a
eval "$(
  grep -E '^(DATABASE_URL|REDIS_URL|COFORGE_CENTRIFUGO_API_URL|COFORGE_CENTRIFUGO_API_KEY|COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY)=' \
    /home/zhoujie22/river2_0/coforge/apps/web/.env
)"
set +a
export COFORGE_SKILLSBENCH_COLLAB_EVAL=1
export COFORGE_WEB_URL=http://127.0.0.1:18888
export OPENVIKING_PROTOTYPE_ENABLED=1
export COFORGE_OPENVIKING_URL=http://127.0.0.1:1933
export COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE=/tmp/pcm-eval-ov-keys.json
export COFORGE_EVAL_ARMS=openviking
if [ -n "${1:-}" ]; then
  export COFORGE_EVAL_TASKS="$1"
fi
# fresh OV account per task; unset so run.ts provisions a disposable one
unset COFORGE_EVAL_OV_ACCOUNT || true
mise exec -- bun benchmark/skillsbench-collab/src/run.ts
