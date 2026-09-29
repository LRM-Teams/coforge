#!/usr/bin/env bash
# Runs the Web integration suites - the ones CI cannot run, because the jobs have no PostgreSQL, so
# nothing exercises them between a developer's machine and `main`.
#
# Their environment is the obstacle: each suite checks its own `<AREA>_TEST_DATABASE_URL` (two of
# them a redis one instead), so the set of names is only learnable one failure at a time. This points
# every one of them at one scratch database and one scratch redis. The list below is the truth about
# how many there are - a count in prose would rot, which is what the guard in scripts/ci is for.
#
#   INTEGRATION_DATABASE_URL=postgresql://coforge:test@127.0.0.1:15440/coforge \
#   INTEGRATION_REDIS_URL=redis://127.0.0.1:16379 \
#     mise run test:integration:web
#
# The defaults match that scratch stack. Apply migrations first, or every suite fails on a missing
# table:
#
#   DATABASE_URL=$INTEGRATION_DATABASE_URL bun run --cwd apps/web db:migrate:deploy
#
# Some suites need more than a database and skip or fail here without it: the Centrifugo-backed ones
# (COFORGE_CENTRIFUGO_API_URL/KEY), `production.integration.ts` (a built `.output/server`) and
# `github-connection.integration.ts` (a reachable GitHub). scripts/ci/integration-env.test.ts keeps
# the list below in step with the names the suites read, so a new area fails loudly at review time
# rather than at run time.
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
database="${INTEGRATION_DATABASE_URL:-postgresql://coforge:test@127.0.0.1:15440/coforge}"
redis="${INTEGRATION_REDIS_URL:-redis://127.0.0.1:16379}"

export DATABASE_URL="$database"
export REDIS_URL="$redis"
# Every name the suites check, spelled out rather than built from an area loop, so that
# `grep _TEST_DATABASE_URL scripts/test/run-web-integration.sh` shows the whole set. The guard in
# scripts/ci/integration-env.test.ts keeps this in step with what the suites read.
for name in \
  AGENT_ACTIVITY_TEST_DATABASE_URL \
  AGENT_SESSION_TEST_DATABASE_URL \
  ATTACHMENT_UPLOAD_SESSION_TEST_DATABASE_URL \
  CHANNEL_TEST_DATABASE_URL \
  EVENTS_TEST_DATABASE_URL \
  GITHUB_COMMIT_TRAILERS_TEST_DATABASE_URL \
  GITHUB_TEST_DATABASE_URL \
  MIGRATION_TEST_DATABASE_URL \
  PREFERENCES_TEST_DATABASE_URL \
  REMINDER_TEST_DATABASE_URL \
  SKILLS_TEST_DATABASE_URL \
  TASK_TEST_DATABASE_URL \
  THREAD_TEST_DATABASE_URL \
  WEEKLY_REPORT_TEST_DATABASE_URL; do
  export "$name=$database"
done
export CHANNEL_TEST_REDIS_URL="$redis"
export SKILLS_TEST_REDIS_URL="$redis"

cd "$root/apps/web"
files=()
for file in "$root"/apps/web/test/*.integration*.ts; do
  # A glob that matched nothing would leave `bun test` with no arguments, and it would then discover
  # and run every test in the package instead - a silent change of subject.
  [ -e "$file" ] || {
    printf 'No integration files matched under %s/apps/web/test.\n' "$root" >&2
    exit 1
  }
  files+=("$file")
done
exec bun test "${files[@]}"
