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
- Adapters emit only official display events and explicit lineage, never raw
  reasoning.

## Runtime inventory and models

- Inventory external CLI providers from the Daemon's effective PATH at startup
  and after reconnect. Report Pi and the built-in CoForge Agent from their
  embedded SDK and version; never scan PATH for them.
- Translate persisted model and reasoning selections into each provider's
  native startup configuration.
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
  become informational `runtime_reconnecting` Activity, matching Raft Computer
  1.0.32's `isCodexProviderReconnectLog`.

## Pi and built-in CoForge Agent

- Pi's Provider embeds the bundled Pi SDK and keeps the user's Pi models,
  settings, packages, extensions, skills, and authentication.
- An explicit Agent key overrides host authentication only in that session's
  in-memory model runtime. Never write it to disk or pass it in process
  arguments.
- Pi session files stay in the Agent's `.pi-sessions` directory. The built-in
  CoForge Agent uses its isolated bundled resources and `.builtin-sessions`.

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
