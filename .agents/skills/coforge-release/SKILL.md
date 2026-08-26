---
name: coforge-release
description: Operate and verify CoForge releases across test and production. Use when an Agent needs to inspect a main deployment, prepare or request a production promotion, promote an immutable image digest after human approval, verify release health or evidence, or roll back a failed release.
---

# CoForge release

Read [`docs/release.md`](../../../docs/release.md) completely before acting. It
is canonical; this Skill only routes and enforces its workflow. Also follow
[`AGENTS.md`](../../../AGENTS.md) for Issue, branch, review, and decision gates.

## Classify the request

- **Inspect**: report the deployed digest, workflow state, health, and blockers
  using read-only operations.
- **Deploy test**: observe or execute the documented `main`-to-`test` workflow.
- **Prepare production**: assemble the exact-digest approval packet, then stop
  before deployment.
- **Promote production**: verify the human approval and execute the documented
  workflow with the same digest that passed test.
- **Rollback**: restore the recorded previous healthy digest under the
  canonical authorization rules.

## Discover the implemented interface

1. Read the current workflow and Compose files from the repository. Use
   `rg --files` to discover their real names; do not rely on remembered paths.
2. Identify the exact source commit, image reference and digest, target
   environment, current healthy digest, previous healthy digest, workflow run,
   and approval record.
3. Compare the implemented inputs and outputs with `docs/release.md`.
4. If the document still says the operator interface is unimplemented, stop
   before external mutation. Report the missing interface and update the
   tracked implementation Issue; do not improvise SSH or Docker commands.

## Inspect or deploy test

For inspection, remain read-only and return the evidence fields defined in the
canonical contract.

For test deployment:

- require a successful `main` commit and immutable registry digest;
- enter the `test` environment concurrency gate;
- run only the repository's documented deployment interface;
- verify container health and external HTTPS health without `--insecure`;
- record the candidate or the restored previous digest as the final result.

Do not rebuild on the server, deploy a mutable tag, expose an internal port, add
an application systemd unit, or change shared Caddy configuration.

## Prepare or promote production

Prepare an approval packet with:

- exact image digest and source commit;
- successful test workflow and health evidence;
- change and risk summary;
- current and previous healthy production digests;
- rollback and database-compatibility statement.

Ask a human to approve that exact digest. Preparation ends there.

Before promotion, re-read the durable approval and require an exact digest
match. Then use only the documented production workflow. Confirm it deploys the
same digest already healthy in test, monitor both health layers, and record the
final digest and workflow run. Never approve the deployment on the human's
behalf or treat a general message such as "release the latest" as approval.

## Roll back

During a failed approved deployment, restore the recorded previous healthy
digest automatically and rerun both health checks. For an unrelated later
rollback, require the authorization specified in `docs/release.md`. Do not
rebuild, retag, or create a Git revert as the operational rollback.

Stop if the previous healthy digest is missing unless the workflow proves and
records a first deployment to an empty environment. Also stop if database
compatibility is not established. Report that rollback is unsafe instead of
guessing.

## Stop conditions

Do not mutate an environment when any of these is true:

- the requested image is not an immutable digest;
- source, test evidence, current state, or rollback target cannot be verified,
  except for a recorded empty-environment bootstrap;
- a deployment for the target environment is already active;
- production approval is absent, stale, ambiguous, or for another digest;
- the repository has no implemented operator interface;
- execution would expose secrets, bypass TLS, use root, or modify shared
  infrastructure outside a separately approved change;
- a database change prevents the previous application digest from working.

## Report the outcome

Return a compact release record:

- environment and final status;
- source commit and exact digest;
- workflow run and approval reference when applicable;
- internal and external health results;
- previous digest and rollback result;
- blockers or follow-up work.

Never print credentials, token-bearing URLs, secret values, or unredacted logs.
