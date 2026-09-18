import { appendFile } from "node:fs/promises";

/**
 * Stand-in for the `cursor-agent` binary: a fresh process per invocation, argv-driven, no stdin.
 * Handles both turn invocations (`--print --output-format stream-json --force ...`) and the
 * `models` subcommand, controlled by `COFORGE_CURSOR_*` env vars so one fixture script covers
 * every scenario the CursorProvider tests exercise.
 */

// A representative excerpt of real `cursor-agent models` output (see
// scratchpad/cursor-probe/models.txt for the full 2026-09-18 capture this is trimmed from).
const DEFAULT_MODELS_OUTPUT = `Available models

auto - Auto (default)
gpt-5.3-codex - Codex 5.3
composer-2.5 - Composer 2.5

Tip: use --model <id> (or /model <id> in interactive mode) to switch.
`;

const argv = process.argv.slice(2);

if (argv[0] === "hang-models") {
  // Never exits - exercises discoverCursorCatalog's own timeout instead of the CLI's.
  await new Promise(() => {});
}

if (argv[0] === "models") {
  const exitCode = Number(Bun.env.COFORGE_CURSOR_MODELS_EXIT ?? "0");
  if (Bun.env.NO_COLOR !== "1" || Bun.env.FORCE_COLOR !== "0") {
    console.error("missing NO_COLOR/FORCE_COLOR for models discovery");
    process.exit(1);
  }
  if (exitCode !== 0) {
    console.error(Bun.env.COFORGE_CURSOR_MODELS_STDERR ?? "models unavailable");
    process.exit(exitCode);
  }
  process.stdout.write(Bun.env.COFORGE_CURSOR_MODELS_OUTPUT ?? DEFAULT_MODELS_OUTPUT);
  process.exit(0);
}

if (!argv.includes("--print") || !argv.includes("--force")) {
  console.error("missing required cursor-agent flags");
  process.exit(1);
}
const outputFormatIndex = argv.indexOf("--output-format");
if (outputFormatIndex < 0 || argv[outputFormatIndex + 1] !== "stream-json") {
  console.error("missing --output-format stream-json");
  process.exit(1);
}
if (Bun.env.NO_COLOR !== "1") {
  console.error("missing NO_COLOR");
  process.exit(1);
}

const modelIndex = argv.indexOf("--model");
const model = modelIndex >= 0 ? argv[modelIndex + 1] : undefined;
const resumeIndex = argv.indexOf("--resume");
const resumeId = resumeIndex >= 0 ? argv[resumeIndex + 1] : undefined;
const prompt = argv.at(-1);

const launchLog = Bun.env.COFORGE_CURSOR_LAUNCH_LOG;
if (launchLog) {
  await appendFile(launchLog, `${JSON.stringify({ prompt, model, resumeId })}\n`);
}

function write(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

const sessionId = resumeId ?? Bun.env.COFORGE_CURSOR_SESSION_ID ?? crypto.randomUUID();
const mode = Bun.env.COFORGE_CURSOR_MODE ?? "text";

if (mode === "replay") {
  // Replays a trimmed real capture verbatim - used to prove the frame types this build
  // observed but does not map (thinking, tool_call, connection, retry, user) produce no events.
  const replayFile = Bun.env.COFORGE_CURSOR_REPLAY_FILE;
  if (!replayFile) throw new Error("COFORGE_CURSOR_REPLAY_FILE is required for replay mode");
  const contents = await Bun.file(replayFile).text();
  for (const line of contents.split("\n")) if (line.trim()) process.stdout.write(`${line}\n`);
  process.exit(Number(Bun.env.COFORGE_CURSOR_REPLAY_EXIT ?? "0"));
}

write({
  type: "system",
  subtype: "init",
  apiKeySource: "login",
  cwd: process.cwd(),
  session_id: sessionId,
  model: model ?? "Auto",
  permissionMode: "default",
});
write({
  type: "user",
  message: { role: "user", content: [{ type: "text", text: prompt }] },
  session_id: sessionId,
});

if (mode === "hang") {
  process.on("SIGINT", () => process.exit(130));
  await new Promise(() => {});
}

const delayMs = Number(Bun.env.COFORGE_CURSOR_TURN_DELAY_MS ?? "0");
if (delayMs > 0) await Bun.sleep(delayMs);

if (mode === "text") {
  write({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "hello from cursor" }] },
    session_id: sessionId,
  });
  write({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "hello from cursor",
    session_id: sessionId,
    usage: {},
  });
  process.exit(0);
}

if (mode === "content-blocks") {
  write({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "considering the request" },
        { type: "tool_use", id: "tool-1", name: "shell", input: { command: "echo hi" } },
        { type: "tool_use", input: { path: "README.md" } },
        { type: "text", text: "" },
        { type: "text", text: "done" },
      ],
    },
    session_id: sessionId,
  });
  write({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: sessionId,
    usage: {},
  });
  process.exit(0);
}

if (mode === "compacting") {
  write({ type: "system", subtype: "status", status: "compacting", session_id: sessionId });
  write({ type: "system", subtype: "compact_boundary", session_id: sessionId });
  write({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    session_id: sessionId,
  });
  write({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    session_id: sessionId,
  });
  process.exit(0);
}

if (mode === "error-result") {
  write({
    type: "result",
    subtype: "error",
    is_error: true,
    errors: ["Something broke"],
    result: "extra detail",
    session_id: sessionId,
  });
  process.exit(0);
}

if (mode === "crash-no-result") {
  console.error(
    "ActionRequiredError: Named models unavailable Free plans can only use Auto. " +
      "Upgrade your plan or remove --model to use Auto.",
  );
  process.exit(1);
}

if (mode === "silent-exit") {
  // Exits cleanly with no result frame at all - a still-failed turn per the reference rule.
  process.exit(0);
}

throw new Error(`unknown COFORGE_CURSOR_MODE: ${mode}`);
