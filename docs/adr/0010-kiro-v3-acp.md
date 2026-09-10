---
status: accepted
date: 2026-09-10
---

# Kiro v3 external runtime

Frank approved Kiro integration, automatic permission approval, and specifically
the v3 engine in [the implementation thread](https://ampcode.com/threads/T-01a08a94-3e06-7163-a78e-855b26075f3f).
The accepted runtime contract is maintained in [architecture.md](../architecture.md).

Kiro remains user-installed and authenticated. Use its official ACP stdio mode,
not interactive terminal parsing, and the stable Apache-2.0
[@agentclientprotocol/sdk 1.4.0](https://github.com/agentclientprotocol/typescript-sdk/tree/v1.4.0)
inside the existing Daemon adapter seam. Kiro itself is not redistributed;
its vendor service terms and subscription remain the user's responsibility.
The SDK uses Web Streams and is verified under the existing Bun runtime; no
new service, runtime version, database schema or local product is introduced.

The compatibility baseline is CLI 2.21.2 with `--agent-engine v3 --auth-method cli`,
which launched Kiro Agent Server 0.58.7 in the probe. CLI version and engine version
are distinct. v2 is deliberately unsupported: its busy prompt rejects input and
its shell cancellation probe continued execution. v3 accepts busy prompt by
cancelling the old turn and starting a new turn, rather than Codex-style steering.
The user authorized implementation after this behavior was reported. Waiting
until idle or simulating steering in a separate queue is not the selected behavior.

`--trust-all-tools` is rejected by this v3 launcher. Use native agent permissions
and ACP automatic approval, respecting enforced deny rules. ACP standard turn
completion is not input admission. Kiro's observed private
`session_info_update / _meta.kiro.kind = user_message_id_assigned` supplies the
admission observation; serialize admission and fail closed on missing evidence.
This extension is a version-sensitive compatibility dependency, not standard ACP.

Kiro 0.58.7 refreshes its model registry asynchronously: initial session and
profile-selection responses may omit the model option. Startup and catalog
discovery therefore consume session-scoped `config_option_update` notifications,
including updates arriving before the session response. Configuration readiness
is bounded and event-driven; it does not retry the launch or silently substitute
a model. The selected model/effort must still be accepted by Kiro. Controlled
tests cover early/late updates, missing configuration, invalid models and process
exit while waiting. This fixes the race capable of producing the intermittent
`Kiro model selection is unavailable` observed during the native E2E probes.

Official references: [ACP](https://kiro.dev/docs/cli/acp.md),
[agent configuration](https://kiro.dev/docs/custom-agents/configuration-reference.md),
[permissions](https://kiro.dev/docs/cli/v3/permissions.md),
[Skills](https://kiro.dev/docs/skills.md), and
[ACP prompt lifecycle](https://agentclientprotocol.com/protocol/prompt-turn).
Runtime probes override contradictory or stale examples in the documentation.

Validation covers native identity recovery, config/instruction injection,
permission callbacks, busy admission and old-turn completion ordering, process
exit, cancellation and full process-tree disposal. v3 foreground-shell probes
confirmed no delayed write after cancellation; that is not proof for every tool.
Ship compatible Web validation before enabling Kiro in Daemon. Rollback disables
Kiro selection and stops its runtimes, preserving native sessions and credentials.
Old Web/Daemon builds reject the new provider string; do not advertise mixed-version
compatibility. No database migration or credential migration is required.

The user subsequently approved read-only access to the current CLI credential
store for on-demand account quota. ACP usage is per-turn/context accounting;
it is not subscription quota, and v3 noninteractive `/usage` was treated as a
model prompt in the probe. The selected approach follows
[CodexBar's reader](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Kiro/KiroUsageLimitsAPI.swift)
and the legacy [AWS operation model](https://github.com/aws/amazon-q-developer-cli/blob/main/crates/amzn-codewhisperer-client/src/operation/get_usage_limits.rs),
without copying a credential refresh implementation or adding a dependency.
Kiro v3's private store/API is not an official stable integration contract.
The compatibility risk is isolated to `kiro/usage.ts`; rollback removes its
`readUsage` hook and UI scan access without touching native credentials.
The live probe returned HTTP 403 while the stored token was expired. After
the native CLI model-list command updated authentication, the same read-only
request returned a monthly CREDIT window and KIRO POWER subscription title.
Unknown profiles/regions and inseparable trial/bonus allocations remain
unavailable rather than guessing an account or percentage. The user additionally
approved optional `creditUsage` amounts in the existing snapshot JSON; no protobuf
envelope change, database schema, service or runtime version is required.
