import { appendFile } from "node:fs/promises";

/**
 * Stand-in for the `opencode` binary: a fresh process per invocation, argv-driven, no stdin.
 * Handles the version probe (`--version`), the catalog (`models [--verbose]`) and turn
 * invocations (`run --format json ...`), controlled by `COFORGE_OPENCODE_*` env vars so one
 * fixture script covers every scenario the OpenCodeProvider tests exercise.
 */

// A representative excerpt of real `opencode models --verbose` output (2026-09-21 capture: one
// `provider/model` row followed by that model's pretty-printed JSON metadata, including the
// `variants` map the reasoning picker is built from).
const DEFAULT_VERBOSE_MODELS_OUTPUT = `opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "name": "Big Pickle",
  "limit": { "context": 200000, "input": 160000, "output": 32000 },
  "capabilities": { "reasoning": true },
  "variants": {
    "low": { "reasoningEffort": "low" },
    "medium": { "reasoningEffort": "medium" },
    "high": { "reasoningEffort": "high" }
  }
}
aiberm/gpt-5.6-luna
{
  "id": "gpt-5.6-luna",
  "providerID": "aiberm",
  "name": "GPT-5.6 Luna",
  "capabilities": { "reasoning": false },
  "variants": {}
}
`;

const DEFAULT_PLAIN_MODELS_OUTPUT = `opencode/big-pickle
aiberm/gpt-5.6-luna
`;

const argv = process.argv.slice(2);

if (argv.includes("--version")) {
  process.stdout.write(`${Bun.env.COFORGE_OPENCODE_VERSION ?? "2.0.7"}\n`);
  process.exit(0);
}

if (argv[0] === "models") {
  if (Bun.env.NO_COLOR !== "1" || Bun.env.FORCE_COLOR !== "0") {
    console.error("missing NO_COLOR/FORCE_COLOR for models discovery");
    process.exit(1);
  }
  const exitCode = Number(Bun.env.COFORGE_OPENCODE_MODELS_EXIT ?? "0");
  const verbose = argv.includes("--verbose");
  const output = verbose
    ? (Bun.env.COFORGE_OPENCODE_MODELS_OUTPUT ?? DEFAULT_VERBOSE_MODELS_OUTPUT)
    : (Bun.env.COFORGE_OPENCODE_PLAIN_MODELS_OUTPUT ?? DEFAULT_PLAIN_MODELS_OUTPUT);
  if (exitCode !== 0) process.stdout.write(verbose ? "" : DEFAULT_PLAIN_MODELS_OUTPUT);
  if (exitCode !== 0) {
    console.error(Bun.env.COFORGE_OPENCODE_MODELS_STDERR ?? "models unavailable");
    process.exit(exitCode);
  }
  process.stdout.write(output);
  process.exit(0);
}

if (argv[0] === "hang-models") {
  // Never exits - exercises discoverOpenCodeCatalog's own timeout instead of the CLI's.
  await new Promise(() => {});
}

if (argv[0] !== "run") {
  console.error(`unexpected opencode invocation: ${argv.join(" ")}`);
  process.exit(1);
}
const formatIndex = argv.indexOf("--format");
if (formatIndex < 0 || argv[formatIndex + 1] !== "json") {
  console.error("missing --format json");
  process.exit(1);
}
if (!argv.includes("--dangerously-skip-permissions")) {
  console.error("missing --dangerously-skip-permissions");
  process.exit(1);
}
const dirIndex = argv.indexOf("--dir");
if (dirIndex < 0 || argv[dirIndex + 1] !== Bun.env.PWD) {
  console.error("--dir must match PWD");
  process.exit(1);
}
if (Bun.env.NO_COLOR !== "1") {
  console.error("missing NO_COLOR");
  process.exit(1);
}

const modelIndex = argv.indexOf("--model");
const model = modelIndex >= 0 ? argv[modelIndex + 1] : undefined;
const variantIndex = argv.indexOf("--variant");
const variant = variantIndex >= 0 ? argv[variantIndex + 1] : undefined;
const sessionIndex = argv.indexOf("--session");
const resumeId = sessionIndex >= 0 ? argv[sessionIndex + 1] : undefined;
const prompt = argv.at(-1);

const launchLog = Bun.env.COFORGE_OPENCODE_LAUNCH_LOG;
if (launchLog) {
  await appendFile(
    launchLog,
    `${JSON.stringify({ prompt, model, variant, resumeId, dir: argv[dirIndex + 1] })}\n`,
  );
}

function write(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

const sessionId = resumeId ?? Bun.env.COFORGE_OPENCODE_SESSION_ID ?? crypto.randomUUID();
const mode = Bun.env.COFORGE_OPENCODE_MODE ?? "text";
const timestamp = Date.now();

write({ type: "step_start", timestamp, sessionID: sessionId, part: { type: "step-start" } });

// A test's own event listener is registered after `createAgentSession` resolved (which happens on
// this first event), so anything written immediately can race the subscription. The delay lets a
// test opt into observing the rest of the turn deterministically.
const turnDelayMs = Number(Bun.env.COFORGE_OPENCODE_TURN_DELAY_MS ?? "0");
if (turnDelayMs > 0) await Bun.sleep(turnDelayMs);

if (mode === "hang") {
  process.on("SIGINT", () => process.exit(130));
  await new Promise(() => {});
}

if (mode === "text") {
  write({
    type: "text",
    timestamp,
    sessionID: sessionId,
    part: { type: "text", text: "hello from opencode" },
  });
  write({
    type: "step_finish",
    timestamp,
    sessionID: sessionId,
    part: { type: "step-finish", tokens: { input: 12, output: 3, cache: { read: 0, write: 0 } } },
  });
  process.exit(0);
}

if (mode === "tool") {
  write({
    type: "tool_use",
    timestamp,
    sessionID: sessionId,
    part: {
      type: "tool",
      tool: "bash",
      callID: "call-1",
      state: { status: "completed", input: { command: "echo hi" }, output: "hi" },
    },
  });
  write({
    type: "text",
    timestamp,
    sessionID: sessionId,
    part: { type: "text", text: "done" },
  });
  process.exit(0);
}

if (mode === "error-event") {
  write({
    type: "error",
    timestamp,
    sessionID: sessionId,
    part: {},
    error: { name: "ProviderAuthError", data: { message: "no credentials for provider opencode" } },
  });
  process.exit(0);
}

if (mode === "crash") {
  console.error("Error: model not found: opencode/nope");
  process.exit(1);
}

if (mode === "silent-exit") {
  process.exit(0);
}

throw new Error(`unknown COFORGE_OPENCODE_MODE: ${mode}`);
