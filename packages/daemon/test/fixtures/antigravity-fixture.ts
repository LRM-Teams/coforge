import { appendFile, rm } from "node:fs/promises";

/**
 * Stand-in for the `agy` binary in headless mode: one process per turn, the prompt read as one
 * `{"event":"user",...}` NDJSON line on stdin, `stream-json` frames on stdout. Controlled by
 * `COFORGE_AGY_*` env vars so one script covers every scenario the AntigravityProvider tests use.
 * The frame shapes are the ones agy 1.2.12/1.2.13 printed on 2026-09-30.
 */

const argv = process.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function flagValue(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (!argv.includes("--print=")) fail("missing --print=");
if (flagValue("--input-format") !== "stream-json") fail("missing --input-format stream-json");
if (flagValue("--output-format") !== "stream-json") fail("missing --output-format stream-json");
if (!argv.includes("--dangerously-skip-permissions"))
  fail("missing --dangerously-skip-permissions");
if (!flagValue("--print-timeout")) fail("missing --print-timeout");
if (Bun.env.NO_COLOR !== "1") fail("missing NO_COLOR");
for (const name of ["SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY"])
  if (Bun.env[name] !== undefined) fail(`${name} leaked into the turn environment`);

const model = flagValue("--model");
const conversation = flagValue("--conversation");
// The working directory, read once: it stops resolving after `COFORGE_AGY_REMOVE_WORKSPACE`.
const workingDirectory = process.cwd();
// agy silently starts a new conversation when `--conversation` names one it cannot find, and
// reports only a stderr warning plus the new id on `init`. `COFORGE_AGY_LOST_CONVERSATION_ID`
// names the one id this fake agy no longer has.
const lost =
  conversation !== undefined && conversation === Bun.env.COFORGE_AGY_LOST_CONVERSATION_ID;
// `COFORGE_AGY_HOLD_LOST_INIT=1` holds the `init` frame of a lost resume until the turn is
// interrupted, so a test can interrupt it before the session has seen the new conversation id. The
// handler is installed before the launch is logged: a test that saw the launch can interrupt.
const heldUntilInterrupted =
  lost && Bun.env.COFORGE_AGY_HOLD_LOST_INIT === "1"
    ? new Promise<void>((resolve) => process.once("SIGINT", () => resolve()))
    : undefined;

const stdin = await new Response(Bun.stdin.stream()).text();
const lines = stdin.split("\n").filter((line) => line.trim());
if (lines.length !== 1) fail(`expected one stdin prompt line, got ${lines.length}`);
const input = JSON.parse(lines[0]!) as { event?: string; message?: { content?: unknown } };
if (input.event !== "user" || typeof input.message?.content !== "string")
  fail("stdin line is not a user event");
const prompt = input.message.content;

const launchLog = Bun.env.COFORGE_AGY_LAUNCH_LOG;
if (launchLog) await appendFile(launchLog, `${JSON.stringify({ prompt, model, conversation })}\n`);

function write(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

const mode = Bun.env.COFORGE_AGY_MODE ?? "text";
await heldUntilInterrupted;
// Test hook: remove the workspace the turn runs in, so the session's next spawn throws.
if (lost && Bun.env.COFORGE_AGY_REMOVE_WORKSPACE === "1")
  await rm(workingDirectory, { recursive: true, force: true });
const conversationId = lost
  ? (Bun.env.COFORGE_AGY_NEW_CONVERSATION_ID ?? crypto.randomUUID())
  : (conversation ?? Bun.env.COFORGE_AGY_CONVERSATION_ID ?? crypto.randomUUID());
if (lost) console.error(`warning: conversation "${conversation}" not found`);

// A local shell wrapper around agy may print a banner line first; the reader must skip it.
if (Bun.env.COFORGE_AGY_BANNER) process.stdout.write(`${Bun.env.COFORGE_AGY_BANNER}\n`);

write({
  event: "init",
  conversation_id: conversationId,
  init: {
    ...(model ? { model } : {}),
    cwd: workingDirectory,
    tools: ["run_command", "view_file", "write_to_file"],
    permission_mode: "always-proceed",
  },
});

const step = (fields: Record<string, unknown>) =>
  write({ event: "step_update", step_update: { conversation_id: conversationId, ...fields } });
const usage = {
  input_tokens: 12827,
  output_tokens: 26,
  thinking_tokens: 24,
  cache_read_tokens: 0,
  total_tokens: 12853,
};
const result = (fields: Record<string, unknown>) =>
  write({
    event: "result",
    result: {
      conversation_id: conversationId,
      duration_seconds: 4.6,
      num_turns: 1,
      usage,
      ...fields,
    },
  });

step({ step_index: 0, state: "DONE", step_type: "user_input" });

if (mode === "hang" || lost) {
  // Runs until the session interrupts or disposes the turn. agy reports an interrupted run as
  // status INTERRUPTED ("the run was interrupted (for example, SIGINT)").
  process.on("SIGINT", () => {
    process.stdout.write(
      `${JSON.stringify({ event: "result", result: { conversation_id: conversationId, status: "INTERRUPTED", response: "" } })}\n`,
      () => process.exit(130),
    );
  });
  process.on("SIGTERM", () => process.exit(143));
  // Signals that the handlers are installed, so a test can interrupt a turn that answers it.
  step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "working" });
  await new Promise(() => {});
}

if (mode === "text") {
  step({
    step_index: 1,
    state: "ACTIVE",
    step_type: "agent_response",
    text_delta: "hello from ",
  });
  step({
    step_index: 1,
    state: "DONE",
    step_type: "agent_response",
    text_delta: "antigravity\n",
    duration_seconds: 4.5,
    usage,
  });
  result({ status: "SUCCESS", response: "hello from antigravity\n" });
  process.exit(0);
}

if (mode === "tools") {
  step({
    step_index: 1,
    state: "ACTIVE",
    step_type: "tool",
    tool_name: "run_command",
    tool_info: { name: "run_command", parameters: { CommandLine: "echo probe-ok" } },
  });
  step({
    step_index: 1,
    state: "DONE",
    step_type: "tool",
    tool_name: "run_command",
    tool_info: {
      name: "run_command",
      parameters: { CommandLine: "echo probe-ok" },
      output: "probe-ok\n",
    },
  });
  step({
    step_index: 2,
    state: "DONE",
    step_type: "tool",
    tool_name: "view_file",
    // A failed step carries an `error` object with `type` and `message` (headless docs).
    tool_info: {
      name: "view_file",
      parameters: { AbsolutePath: "/missing" },
      error: { type: "NOT_FOUND", message: "not found" },
    },
  });
  step({
    step_index: 3,
    state: "DONE",
    step_type: "tool",
    tool_name: "browser_scroll",
    tool_info: { name: "browser_scroll", parameters: { Direction: "down" } },
  });
  step({
    step_index: 4,
    state: "DONE",
    step_type: "tool",
    tool_name: "write_to_file",
    tool_info: {
      name: "write_to_file",
      parameters: { TargetFile: "/tmp/probe.txt", CodeContent: "probe" },
    },
  });
  step({ step_index: 5, state: "DONE", step_type: "checkpoint" });
  step({
    step_index: 6,
    state: "DONE",
    step_type: "agent_response",
    text_delta: "done\n",
    usage,
  });
  result({ status: "SUCCESS", response: "done\n", num_turns: 1 });
  process.exit(0);
}

if (mode === "subagent") {
  // The frames agy 1.2.13 printed for a delegated task: the subagent runs on its own, and only its
  // report comes back later as a system message.
  const subagent_info = {
    subagents: [
      {
        type_name: "self",
        role: "File Counter",
        initial_prompt: "Count the .txt files in the current working directory.",
        conversation_id: "a05cf0f1-1c60-432a-a2e4-628e5ea4ff4a",
        log_uri: "file:///home/user/.gemini/antigravity-cli/brain/a05cf0f1/transcript.jsonl",
        workspace_uris: ["file:///home/user/workspace"],
      },
    ],
  };
  const tool_name = "invoke_subagent";
  step({ step_index: 1, state: "DONE", step_type: "agent_response", usage });
  step({ step_index: 2, state: "ACTIVE", step_type: "subagent", tool_name, subagent_info });
  step({ step_index: 2, state: "DONE", step_type: "subagent", tool_name, subagent_info });
  step({ step_index: 3, state: "DONE", step_type: "system_message" });
  step({ step_index: 4, state: "DONE", step_type: "agent_response", text_delta: "2\n", usage });
  result({ status: "SUCCESS", response: "2\n" });
  process.exit(0);
}

if (mode === "error-result") {
  step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "partial" });
  result({ status: "ERROR", response: "partial", error: "model quota exhausted" });
  console.error('AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","retryable":false}');
  process.exit(3);
}

if (mode === "crash-no-result") {
  console.error("Error: not signed in; run agy and sign in first");
  process.exit(1);
}

if (mode === "silent-exit") process.exit(0);

throw new Error(`unknown COFORGE_AGY_MODE: ${mode}`);
