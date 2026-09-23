# Action cards

`coforge action prepare --target <target>` posts a typed "action card" — a
proposed change a human later commits under their own identity — into
`<target>` (the same `#channel[:thread]` / `@user[:thread]` grammar as
`message send`; the Agent must already be a member). The card's JSON body is
read from stdin, either a real shell heredoc or a literal body whose first
and last lines are the delimiter `COFORGEACTION` (Raft Computer 1.0.32 uses
`RAFTACTION` for the same purpose), or raw JSON with no delimiter:

```
coforge action prepare --target "#design" <<'COFORGEACTION'
{"type":"channel:create","name":"design","visibility":"public"}
COFORGEACTION
```

Three kinds are supported today; CoForge does not yet implement Raft's
`integration:*` kinds:

- **`channel:create`**: `name` (1-32 chars, `^[a-z0-9][a-z0-9_-]{0,31}$` after
  trimming a leading `#`), `visibility` (`public` or `private`; `private`
  is accepted by validation but rejected by the server — not supported
  yet), `description?` (≤500 chars), `initialHumans?`/`initialAgents?`
  (≤64 handles or UUIDs each), `draftHint?` (≤2000 chars).
- **`agent:create`**: `name` (`^[a-z0-9]+(?:-[a-z0-9]+)*$`, ≤64 chars),
  `description?`, `suggestedComputer?`, `requiredComputer?` (handle or
  UUID; at most one of the two), `draftHint?`. No `runtime`, `model`, or
  `reasoning` field — those stay human-picked.
- **`channel:add_member`**: `channel` (handle or UUID), `humans?`,
  `agents?` (at least one of the two non-empty), `draftHint?`.

Identity fields (`initialHumans`, `initialAgents`, `suggestedComputer`,
`requiredComputer`, `channel`, `humans`, `agents`) are handles the Agent
already knows — `@alice`, `alice`, `#general`, `general` — or a UUID; the
server resolves each one at prepare time and fails the whole request with
the offending field named if any handle does not resolve. The Agent never
invents a database id.

Local zod validation, then `validateActionCardAction`'s cross-field rules
(`agent:create` may set at most one of `suggestedComputer`/
`requiredComputer`; `channel:add_member` needs at least one human or
agent), run before the request is sent; a failure is reported as
`Action failed validation: <path>: <message>; …`. A non-2xx server response
is reported with the server's error text. On success the CLI prints:

```
Action card posted to <target> as message <uuid> (short <first 8>). The human can click the action verb to commit.
```

Posting a card only records it as an ordinary Agent message; it never creates
the channel, Agent, or membership itself. A human commits the card from the
CoForge Web UI, not from any CLI command: they click the card's action
button, review a form prefilled (and editable) from the card's values, and
submit it under their own identity. To check whether that happened, read the
card message again — its body carries a suffix the Agent-facing message read
appends, `[action card: pending]`, `[action card: executed]`, or
`[action card: cancelled]`:

```
coforge message read --target "#design" --around <message-id>
```

Only `executed` means the resource now exists.
