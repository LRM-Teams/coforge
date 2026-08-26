---
name: coforge-release
description: Operate and verify CoForge releases across test and production. Use when an Agent needs to inspect a main deployment, prepare or request a production promotion, promote an immutable image digest after human approval, verify release health or evidence, or roll back a failed release.
---

# CoForge release

Read [`docs/release.md`](../../../docs/release.md) completely before acting. It
is canonical; this Skill only routes and enforces its workflow. Also follow
[`AGENTS.md`](../../../AGENTS.md) for Issue, branch, review, and decision gates.

## Classify authority

- **Inspect** is strictly read-only. Report state and blockers; never update an
  Issue or another external record unless the current task separately and
  explicitly authorizes that write.
- **Deploy test**: observe or execute the documented `main`-to-`test` workflow.
- **Prepare production**: assemble the exact-digest approval packet, then stop
  before deployment.
- **Promote production**: verify the human approval and execute the documented
  workflow with the same digest that passed test.
- **Rollback**: restore the recorded previous healthy digest under the
  canonical authorization rules.

## Discover the implemented interface

1. Use `rg --files` to discover the current workflow and Compose files; do not
   rely on remembered paths.
2. Compare their real operator inputs and outputs with the canonical contract.
3. If the document still says the operator interface is unimplemented, stop
   before external mutation, report the missing interface, and identify its
   tracked implementation Issue when one is discoverable. Only update that
   Issue when the current task explicitly authorizes project work. Never
   improvise SSH or Docker commands.

## Route the operation

- **Inspect**: collect the fields in **Release identity and evidence** and
  **Audit records** using read-only operations.
- **Deploy test**: execute **Main to test**, including **Health verification**
  and its audit record, only through the implemented interface.
- **Prepare production**: assemble the packet in **Test to production**, ask a
  human to approve the exact digest, and stop.
- **Promote production**: re-read the durable approval, require an exact digest
  match, then execute **Test to production** through the implemented interface.
  The Agent may execute and monitor; it cannot supply the human approval.
- **Rollback**: follow **Rollback** for authorization and target selection, then
  verify and audit the result through the same implemented interface.

For every mutating operation, apply **Routine release boundary** before the
first mutation. Also stop when another deployment owns the environment gate or
when the implemented interface cannot provide the required evidence. Report a
blocker instead of weakening TLS, exposing secrets, guessing a target, or
changing shared infrastructure.

## Return

Return the compact record defined by **Release identity and evidence** and
**Audit records**, plus blockers and follow-up work. Never print credentials,
token-bearing URLs, secret values, or unredacted logs.
