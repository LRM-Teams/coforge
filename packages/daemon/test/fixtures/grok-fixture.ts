import { appendFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Stand-in for the `grok` binary: a fresh process per invocation, argv-driven. Handles the version
 * probe (`--version`) and one-shot headless turns (`-p <prompt> --output-format streaming-json
 * ...`), controlled by `COFORGE_GROK_*` env vars so one fixture script covers every scenario the
 * GrokProvider tests exercise.
 *
 * The turn surface follows the Grok user guide (14-headless-mode.md, 17-sessions.md) and what
 * grok 1.0.41 was observed to do:
 * - The stream is one `type`-tagged JSON object per line, `end` is always the last event, and its
 *   `stopReason` is snake_case (`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`,
 *   `cancelled`).
 * - `--session-id <uuid>` creates a NEW session and fails with "already in use" for an id whose
 *   session exists, even when the turn that created it failed early; `--resume <id>` fails with
 *   the "not found locally ... Failed to restore session from remote" stderr for an id that has no
 *   session. A session is a directory under `COFORGE_GROK_SESSIONS_DIR`, created before anything
 *   else a turn does, so a test seeds an existing session with `mkdir`.
 */

const argv = process.argv.slice(2);

if (argv.includes("--version")) {
  process.stdout.write(`grok ${Bun.env.COFORGE_GROK_VERSION ?? "1.0.41"} (4220f3b224a6)\n`);
  process.exit(0);
}

// A turn invocation always carries the flags the adapter is contracted to send; a fixture that
// observes one missing means the adapter drifted from the verified 1.0 surface.
if (
  !argv.includes("--output-format") ||
  argv[argv.indexOf("--output-format") + 1] !== "streaming-json"
) {
  console.error("missing --output-format streaming-json");
  process.exit(1);
}
if (!argv.includes("--always-approve")) {
  console.error("missing --always-approve");
  process.exit(1);
}
if (!argv.includes("--no-memory")) {
  console.error("missing --no-memory");
  process.exit(1);
}
if (!argv.includes("--trust")) {
  console.error(
    "missing --trust (project skills and instructions load only from a trusted folder)",
  );
  process.exit(1);
}
if (!argv.includes("--rules")) {
  console.error("missing --rules (the standing instructions ride every turn)");
  process.exit(1);
}
if (!Bun.env.PWD) {
  console.error("missing PWD for the agent workspace");
  process.exit(1);
}
const sessionsDir = Bun.env.COFORGE_GROK_SESSIONS_DIR;
if (!sessionsDir) {
  console.error("missing COFORGE_GROK_SESSIONS_DIR (where the fixture keeps its sessions)");
  process.exit(1);
}

const promptIndex = argv.indexOf("-p");
const prompt = promptIndex >= 0 ? argv[promptIndex + 1] : undefined;
const rulesIndex = argv.indexOf("--rules");
const rules = rulesIndex >= 0 ? argv[rulesIndex + 1] : undefined;
const sessionIdIndex = argv.indexOf("--session-id");
const newSessionId = sessionIdIndex >= 0 ? argv[sessionIdIndex + 1] : undefined;
const resumeIndex = argv.indexOf("--resume");
const resumeId = resumeIndex >= 0 ? argv[resumeIndex + 1] : undefined;
const modelIndex = argv.indexOf("--model");
const model = modelIndex >= 0 ? argv[modelIndex + 1] : undefined;
const effortIndex = argv.indexOf("--reasoning-effort");
const effort = effortIndex >= 0 ? argv[effortIndex + 1] : undefined;
// `--session-id` and `--resume` are mutually exclusive: a session names itself once, every later
// turn resumes.
if (newSessionId && resumeId) {
  console.error("--session-id and --resume passed on the same turn");
  process.exit(1);
}

const launchLog = Bun.env.COFORGE_GROK_LAUNCH_LOG;
if (launchLog) {
  await appendFile(
    launchLog,
    `${JSON.stringify({
      prompt,
      rules,
      newSessionId,
      resumeId,
      model,
      effort,
      trust: argv.includes("--trust"),
      dir: Bun.env.PWD,
    })}\n`,
  );
}

function write(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const sessionId = newSessionId ?? resumeId ?? crypto.randomUUID();
if (resumeId) {
  if (!(await exists(join(sessionsDir, resumeId)))) {
    // Test hook: remove the workspace the turn runs in, so the adapter's next spawn throws.
    if (Bun.env.COFORGE_GROK_REMOVE_WORKSPACE === "1")
      await rm(process.cwd(), { recursive: true, force: true });
    console.error(`Session "${resumeId}" not found locally, restoring conversation from remote...`);
    console.error(
      "Error: Failed to restore session from remote: fetching session record: session get failed: 404 Not Found",
    );
    process.exit(1);
  }
} else {
  if (await exists(join(sessionsDir, sessionId))) {
    console.error(`Error: Error: Session ID ${sessionId} is already in use.`);
    process.exit(1);
  }
  await mkdir(join(sessionsDir, sessionId), { recursive: true });
}

// Same stdin-EOF reproduction as the OpenCode fixture (#652): a child spawned with an open stdin
// pipe hangs forever when the CLI waits for EOF; opt in so the adapter test proves the turn
// process closes stdin.
if (Bun.env.COFORGE_GROK_REQUIRE_STDIN_EOF === "1") {
  for await (const _chunk of Bun.stdin.stream()) {
    // Discard: nothing is being fed, the CLI is only waiting for the close.
  }
}

// The turn that creates a session (the one carrying `--session-id`) may behave differently from
// the turns that resume it: `COFORGE_GROK_NEW_SESSION_MODE` overrides the mode for that one turn.
const mode =
  (newSessionId ? Bun.env.COFORGE_GROK_NEW_SESSION_MODE : undefined) ??
  Bun.env.COFORGE_GROK_MODE ??
  "text";
const turnDelayMs = Number(Bun.env.COFORGE_GROK_TURN_DELAY_MS ?? "0");
if (turnDelayMs > 0) await Bun.sleep(turnDelayMs);

const USAGE = {
  input_tokens: 812,
  output_tokens: 45,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  reasoning_tokens: 0,
};

/** The frames a turn opens with: the tool and slash-command lists, announced repeatedly. */
function announceCommands(): void {
  for (let count = 0; count < 2; count += 1)
    write({
      type: "available_commands",
      tools: ["read_file", "run_terminal_command"],
      commands: [],
    });
}

/** The per-response boundary line grok writes after each model response. */
function endResponse(): void {
  write({
    type: "usage",
    messageId: "resp_1",
    stopReason: "end_turn",
    usage: USAGE,
    signature: "sig",
  });
}

/** The last event of every turn. */
function endTurn(stopReason = "end_turn"): void {
  write({
    type: "end",
    stopReason,
    sessionId,
    requestId: "req_1",
    usage: USAGE,
    num_turns: 1,
    modelUsage: {},
  });
}

if (mode === "text") {
  announceCommands();
  write({ type: "text", data: "hello from grok" });
  endResponse();
  endTurn();
  process.exit(0);
}
if (mode === "thinking") {
  announceCommands();
  write({ type: "thought", data: "thinking about it" });
  write({ type: "text", data: "answer" });
  endResponse();
  endTurn();
  process.exit(0);
}
// A turn whose `end` carries the stop reason in `COFORGE_GROK_STOP_REASON`.
if (mode === "end-reason") {
  announceCommands();
  write({ type: "text", data: "partial answer" });
  endResponse();
  endTurn(Bun.env.COFORGE_GROK_STOP_REASON ?? "cancelled");
  process.exit(0);
}
// The failure shape verified on 1.0.41 for a turn that fails early: one `error` frame on stdout, no
// `end`, exit 1.
if (mode === "error") {
  write({ type: "error", message: Bun.env.COFORGE_GROK_ERROR ?? "boom" });
  process.exit(1);
}
// An `error` frame in a turn that still ends with `end_turn` and exits cleanly.
if (mode === "error-then-end") {
  announceCommands();
  write({ type: "text", data: "partial answer" });
  write({ type: "error", message: Bun.env.COFORGE_GROK_ERROR ?? "boom" });
  endResponse();
  endTurn();
  process.exit(0);
}
// A crash before any frame: exit 1 with only stderr.
if (mode === "crash") {
  console.error(Bun.env.COFORGE_GROK_CRASH_STDERR ?? "Error: could not reach the xAI API");
  process.exit(1);
}
// A turn that runs until it is interrupted. Real grok 1.0.41, sent SIGINT mid-tool, dies at once by
// the signal: no `error` frame, no `end` frame, nothing on stderr. The fixture installs no handler,
// so it does the same, and only the first `text` frame precedes the interrupt.
if (mode === "hang") {
  announceCommands();
  write({ type: "text", data: "working" });
  await Bun.sleep(60_000);
}
// Tool calls in the shapes captured from grok 1.0.41 (a shell command that exits 1, a file read, a
// read of a missing file): a `tool_call` opens the call `pending`; its `tool_call_update`s then
// carry `status` `null`, `in_progress` and finally `completed` or `failed`. `rawOutput` is an
// object (`Bash`, `ReadFile`), never text; the display text is in `content` as
// `{type:"content", content:{type:"text", text}}` entries. The first update's `content` is the
// command's description, and a shell command that exits 1 still ends `completed`.
if (mode === "tools") {
  const workspace = Bun.env.PWD ?? "";
  const textContent = (text: string) => [{ type: "content", content: { type: "text", text } }];
  const toolCall = (toolCallId: string, toolName: string, kind: string, rawInput: unknown) =>
    write({
      type: "tool_call",
      toolCallId,
      title: toolName,
      kind,
      status: "pending",
      toolName,
      rawInput,
      content: [],
      locations: [],
    });
  const update = (
    toolCallId: string,
    status: string | null,
    content: unknown,
    rawOutput: unknown,
  ) => write({ type: "tool_call_update", toolCallId, status, content, rawOutput, locations: [] });
  const bash = (command: string, output: string, exitCode: number, extra = {}) => ({
    type: "Bash",
    output: [...Buffer.from(output)],
    output_for_prompt: output,
    exit_code: exitCode,
    command,
    truncated: false,
    signal: null,
    timed_out: false,
    description: null,
    current_dir: workspace,
    output_file: "/fixture-sessions/terminal/call.log",
    total_bytes: output.length,
    ...extra,
  });
  announceCommands();

  // A file read that succeeds.
  const present = join(workspace, "present.txt");
  toolCall("call-fixture-0", "read_file", "read", { target_file: present });
  write({
    type: "tool_call_update",
    toolCallId: "call-fixture-0",
    status: null,
    content: [],
    rawOutput: null,
    locations: [{ path: present }],
  });
  update("call-fixture-0", "completed", textContent("1\u2192hello\n"), {
    type: "ReadFile",
    FileContent: {
      content: "1\u2192hello\n",
      content_concise: "1\u2192hello\n",
      absolute_path: present,
      offset: null,
      raw_output: "hello\n",
      total_lines: 2,
    },
  });

  // A shell command that exits 1 and still ends `completed`.
  const failing = "echo probe-ok ; ls /definitely-missing-dir";
  const failingOutput = "probe-ok\nls: /definitely-missing-dir: No such file or directory\n";
  toolCall("call-fixture-1", "run_terminal_command", "execute", {
    command: failing,
    description: "Echo probe-ok then list missing dir",
  });
  update("call-fixture-1", null, textContent("Echo probe-ok then list missing dir"), null);
  update("call-fixture-1", "in_progress", textContent(""), bash(failing, "", 0));
  update(
    "call-fixture-1",
    "in_progress",
    textContent(failingOutput),
    bash(failing, failingOutput, 0),
  );
  update(
    "call-fixture-1",
    "completed",
    textContent(failingOutput),
    bash(failing, failingOutput, 1, { output_for_prompt: `exit: 1\n${failingOutput}` }),
  );
  // A repeated terminal update must not end the call twice (the fixture's own addition).
  update(
    "call-fixture-1",
    "completed",
    textContent(failingOutput),
    bash(failing, failingOutput, 1),
  );

  // A read of a file that does not exist ends `failed`.
  const missing = join(workspace, "missing.txt");
  const notFound = `Error: ${missing} does not exist.\nNote: your current working directory is ${workspace}`;
  toolCall("call-fixture-2", "read_file", "read", { target_file: missing });
  write({
    type: "tool_call_update",
    toolCallId: "call-fixture-2",
    status: null,
    content: [],
    rawOutput: null,
    locations: [{ path: missing }],
  });
  update("call-fixture-2", "failed", textContent(notFound), {
    type: "ReadFile",
    FileNotFound: notFound,
  });

  // A shell command that succeeds.
  toolCall("call-fixture-3", "run_terminal_command", "execute", {
    command: "echo hi",
    description: "Say hi",
  });
  update("call-fixture-3", null, textContent("Say hi"), null);
  update("call-fixture-3", "completed", textContent("hi\n"), bash("echo hi", "hi\n", 0));

  // A shell command that timed out. The captures show `timed_out` only as `false`; the fixture's
  // own data for it is `true` beside an exit code of 0, so the field is the only signal.
  toolCall("call-fixture-4", "run_terminal_command", "execute", {
    command: "sleep 999",
    description: "Wait",
  });
  update("call-fixture-4", null, textContent("Wait"), null);
  update(
    "call-fixture-4",
    "completed",
    textContent("partial\n"),
    bash("sleep 999", "partial\n", 0, { timed_out: true }),
  );

  write({ type: "text", data: "done" });
  endResponse();
  endTurn();
  process.exit(0);
}
// Every documented frame the adapter has no use for, plus one type the guide does not list.
if (mode === "documented-frames") {
  announceCommands();
  write({ type: "plan", entries: [{ content: "look around", status: "pending" }] });
  // The guide documents only the `auto_compact_*` prefix, not the event names behind it.
  write({ type: "auto_compact_started" });
  if (Bun.env.COFORGE_GROK_UNKNOWN_FRAME) write({ type: Bun.env.COFORGE_GROK_UNKNOWN_FRAME });
  write({ type: "text", data: "hello from grok" });
  endResponse();
  endTurn();
  process.exit(0);
}
process.exit(0);
