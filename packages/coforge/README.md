# `coforge` Agent-facing CLI

This binary is the stable command boundary exposed to code agents. Message
transport is intentionally injected by the eventual host; the standalone
binary currently reports a clear unavailable-transport error.

`coforge inbox check` returns a local, non-consuming union of pending
`message_target` attention and typed `app` items. It never performs a cloud
Message read, clears Message attention, or acknowledges an App item.
The generic Inbox CLI does not expose acknowledgement. Each App owns any
completion command and concurrency token required by its domain.

Before `message send`, Web/backend may return `sideEffectDecision: "hold"` with
canonical `messages` instead of pretending the send succeeded. The daemon keeps
only the draft body and Web/backend's opaque hold token. After consuming that
context, retry the preserved body with `message send --send-draft`. Agents never
see or supply tokens or sequence numbers. A retry always repeats the exact target with
`message send --target "@user" --send-draft`. `--anyway` requests a server-authorized
bypass, is valid only with `--send-draft`, and is rejected until Web/backend has
issued a second consecutive hold. A successful send consumes the held state.

`coforge message read --target "@user"` reads history with a default limit of
50 (maximum 100). Continue with opaque message-id cursors via `--before`,
`--after`, or `--around`; these options are mutually exclusive. Sequence
numbers are server-internal and are never supplied by an Agent.

Pass `--reviewer-isolation` on `message send`, `task claim`, `task update`, or
`task amend` (or set `COFORGE_REVIEWER_ISOLATION=1`/`true`, accepted
alongside `0`/`false`) when a reviewer agent must act without seeing newer
conversation context. The flag requests `freshnessContextMode: "withheld"`
from the server. If the action is held on a freshness check, the CLI prints
only the count of withheld messages — never their bodies — as
`Reviewer-isolation freshness hold: N newer message(s) withheld.`, and any
other transport failure is reported generically (upstream detail withheld)
rather than surfacing the server's response text.
