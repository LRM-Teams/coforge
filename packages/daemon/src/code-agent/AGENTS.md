# code-agent instructions

Rules for the provider seam and adapters in `src/code-agent/`. They extend
`packages/daemon/AGENTS.md`.

## Provider seam

- `CodeAgentProvider` is the sole public runtime seam. A Provider creates
  one-session `AgentSession` instances and owns its runtime discovery, model
  catalog, and usage capabilities; it may compose them from provider-internal
  modules.
- The registry returns Providers, never lifecycle wrappers or forwarding
  adapters.
- Higher layers consume normalized status and Activity messages and must not
  parse Claude Code, Codex, Pi, or any other provider's output.
- A Provider that knows why a launch cannot start throws a typed launch error
  from `contract.ts` (`RuntimeVersionUnsupportedError`,
  `RuntimeModelNotFoundError`, `ModelProviderSettingError`), keeping any SDK
  error as its `cause`. The Pi Provider maps the SDK's `PiLaunchError` policy
  codes here.
- Adapters emit only official display events and explicit lineage, never raw
  reasoning.
- A `notice-undelivered` for a turn comes before that turn's `completed`, and
  echoes the `deliveryIds` `notify` was given: the daemon settles tracked
  mentions on `completed`. Kiro waits, bounded, for the turn's steering
  outcome before reporting the turn ended.

## Runtime inventory and models

- Inventory external CLI providers from the Daemon's effective PATH at startup
  and after reconnect. Report Pi and the built-in CoForge Agent from their
  embedded SDK and version; never scan PATH for them.
- Translate persisted model and reasoning selections into each provider's
  native startup configuration.
- Bound every catalog discovery with `CATALOG_DISCOVERY_TIMEOUT_MS` per wait.
  Pi's in-process SDK call gets the network refresh cap plus one wait
  (`PI_CATALOG_DISCOVERY_TIMEOUT_MS`, derived from `PI_MODEL_REFRESH_TIMEOUT_MS`
  in `@coforge/agent`) because that refresh is capped separately and the
  resource loader runs after it. A CLI that fetches its list over the network
  has its own deadline next to its catalog reader (`opencode models --verbose`,
  `agy models`). A discovery that fails or times out leaves its
  provider out of that pass, is logged as `code_agent_catalog:discovery_failed`,
  and is never cached.
- Report the maintained Claude Code model catalog when Claude Code is
  installed. Never launch the CLI to infer a dynamic catalog; its
  machine-readable initialization does not give a dependable list.

## Standing instructions

- Keep the standing CoForge Agent instructions in one provider-neutral source,
  `agent-instructions.ts`. `AgentProcessManager` builds them once per session
  and passes them through the required `AgentSessionOptions.instructions`.
- Keep transport guidance minimal: identity, `Current Runtime Context`,
  communication, on-demand context recovery, safety, and help. The fixed
  prompt budget is 3KB excluding dynamic identity data. Ordinary questions and untracked DM work need no Task or per-turn memory bookkeeping;
  only before a long task does the Agent note where it is in
  `notes/active-context.md` (not MEMORY.md) so it can resume.
  An inbox notice lists targets — `check --target` those and reply; do not
  read MEMORY.md first. Replies default to where the conversation is (top
  level, its thread, or a claimed Task's thread); a new topic or a thread's
  conclusion may go top level, a human-named place wins, and the thread-mismatch
  send confirmation defers to that default. Before implementing shared channel work, claim the original top-level message
  or existing Task. Only the successful claimant implements; peers may analyze
  or review in its thread.
  Feature workflows come from event output and the Manual, not the standing
  prompt. Manual get/search `--intent`/`--reason` are optional; deploy a
  compatible Web before upgraded CLI/Daemon, and roll clients back before the
  server. A check/read/resolve window that contains tracked Tasks includes
  one Tasks-manual pointer; ordinary messages do not.
- Every Provider injects them through the provider's native system or developer
  instruction mechanism: Codex app-server `developerInstructions`, the Claude
  Code system-prompt-file option, and the CoForge Agent resource-loader
  system-prompt override.
- Do not copy the text into a provider. Do not write `AGENTS.md` or `CLAUDE.md`
  into the user's Agent workspace for a provider that supports native
  injection.
- Deliver Message recovery bodies directly as turn input and App Inbox wakeups
  separately. Never append them to the standing instructions.
- When a session lacks older user-referenced context, the instructions direct
  the Agent to lexical `coforge message search`, then a target-scoped
  `message read --around`.

## Assigned skills

- `assigned-skills.ts` refreshes platform-owned skills on Agent launch using a
  content hash. Preserve edited or unknown same-named files. Exact known legacy
  hashes allow migration of pre-marker installs; retire only unchanged platform
  files and keep other files in their directories.
- Weekly-report conversation guidance lives in navigation; writing is reserved
  for platform extraction/Collect wakes. Shared communication and safety belong
  in `agent-instructions.ts`, not feature skills.

## Codex

- `codex/provider.ts` owns retry classification. Structured `willRetry: true`
  notifications stay internal diagnostics. Numbered stderr reconnect lines
  become informational `runtime_reconnecting` Activity.

## Antigravity (`agy`)

- One headless process per turn. The prompt is one stdin line under
  `--input-format stream-json`, never argv. agy has no system-prompt channel,
  so a fresh conversation's first turn is the standing instructions alone.
- An unknown `--conversation` id is not an error in agy: it starts a new
  conversation. Compare the `init` frame's id with the requested one and
  re-bootstrap on a mismatch, or the Agent runs without its instructions.
- Never pass `SSH_CLIENT`, `SSH_CONNECTION`, or `SSH_TTY` to an agy turn,
  `agy models`, or `agy -p /usage`; agy switches to a file-based token store when it sees them. An
  explicit Agent override still applies.
- `antigravity/tool-call.ts` maps agy tool names to canonical tools and moves
  only verified argument fields; a `subagent` step is one `invoke_subagent`
  tool call with no input, since its prompt and local paths are not Activity.
- Account usage is `agy -p /usage --output-format json`, which answers without
  a turn; the snapshot shows the model group with the least quota left. Only an
  error naming sign-in or auth is `UsageUnavailableError`; a signed-out answer
  was never captured, so that match is assumed.
- The unknown-`--conversation` fallback, the `agy models` line format, and the
  SSH token-store switch are observed on agy 1.2.12/1.2.13, not documented.
  Re-check them when raising the version gate.

## Grok Build (`grok`)

- One headless process per turn: `grok -p <prompt> --output-format streaming-json`. The prompt rides
  argv and the standing instructions ride `--rules` on every turn, so a fresh session spawns
  nothing until real input arrives. The CLI's guide ships with it in `~/.grok/docs/user-guide/`.
- The session id is ours: a UUID pinned with `--session-id`, which creates a new session and refuses
  an id that exists. Clear that flag when a turn is spawned with it, never when it exits: grok
  creates the session before the turn can fail. Every later turn is `--resume`. A session the
  daemon asks to `create` is pinned; a `resume` grok has no session for is re-run as a fresh session
  under a new id and reported with `onSessionId(new, replaced)`.
- Every turn passes `--trust`. Headless startup loads project skills and instructions only from a
  trusted folder (`22-permissions-and-safety.md`), and assigned skills are installed in
  `<Agent workspace>/.grok/skills`. It records the Agent workspace in `~/.grok/trusted_folders.toml`
  and, per `10-hooks.md`, trusts that folder's hooks and MCP and LSP servers with it. Global skills
  (`$GROK_HOME/skills`) load without it. Folder trust is a security boundary: get Frank's approval
  before widening it past the Agent workspace or dropping it.
- Tool events pass grok's `toolName` and `rawInput` through, except that `read_file`'s `target_file`
  is carried as the `file_path` the daemon core reads (`grok/tool-call.ts`); canonical names and
  argument summaries belong to `tool-activity.ts`. The output text is the terminal update's `content`
  text entries (`rawOutput` is an object, never text). A shell command that exits non-zero or times
  out still ends `completed`, so the error comes from `rawOutput.exit_code` and `timed_out`; a call
  grok could not run ends `failed`.
- Observed on grok 1.0.41, not documented: the tool frame shapes above, `--session-id` refusing an
  existing id, the session a failed first turn leaves behind, the missing-session stderr
  (`not found locally`, `Failed to restore session`), and SIGINT, which kills grok at once by the
  signal with no `error` or `end` frame (so `interrupt()` is reported by the exit, never by a frame).
  `--trust` and `--no-memory` are hidden flags: absent from `grok --help`, accepted; the guide's
  headless flag table also omits `--always-approve` (it lists `--yolo`). Re-check all of these when
  raising the version gate.

## Pi and built-in CoForge Agent

- Pi's Provider embeds the bundled Pi SDK and keeps the user's Pi models,
  settings, packages, extensions, skills, and authentication.
- An explicit Agent key overrides host authentication only in that session's
  in-memory model runtime. Never write it to disk or pass it in process
  arguments.
- Pi session files stay in the Agent's `.pi-sessions` directory. The built-in
  CoForge Agent uses its isolated bundled resources and `.builtin-sessions`;
  for skills, the Pi SDK still loads the user's `~/.agents/skills`, so that is
  the one Global root its Skills metadata reports.

## Skills metadata (`agent-skills.ts`)

- Discovery of Global and Workspace Skills metadata at provider-native roots
  is bounded and read-only.
- A metadata query never launches a provider, reloads a session, copies global
  skills, or changes the established runtime environment composition.

## Claude Code context report (`claude-code/context-report.ts`)

- It is a one-shot `/context` read that relies on undocumented headless
  behaviour. Run it against the Agent's own live session inside the Agent's
  workspace directory.
- Answer `no_session`, `unsupported`, `unparsed`, `timeout`, or `error` in
  plain words.
- Only the parsed structure goes on the wire; the raw Markdown never leaves the
  Computer. Format drift is a visible `unparsed` state, never a crash.
