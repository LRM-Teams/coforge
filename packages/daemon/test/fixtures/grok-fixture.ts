import { appendFile } from "node:fs/promises";

/**
 * Stand-in for the `grok` binary: a fresh process per invocation, argv-driven. Handles the version
 * probe (`--version`) and one-shot headless turns (`-p <prompt> --output-format streaming-json
 * ...`), controlled by `COFORGE_GROK_*` env vars so one fixture script covers every scenario the
 * GrokProvider tests exercise.
 *
 * The turn surface mirrors Grok Build 1.0: the prompt rides `-p`, `--output-format streaming-json`
 * emits one ACP-shaped session update per NDJSON line, and a fresh session carries
 * `--session-id <uuid>` while a resumed one carries `--resume <id>`.
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
if (!argv.includes("--rules")) {
  console.error("missing --rules (the standing instructions ride every turn)");
  process.exit(1);
}
if (!Bun.env.PWD) {
  console.error("missing PWD for the agent workspace");
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
// `--session-id` and `--resume` are mutually exclusive: a fresh session names itself once, every
// later turn resumes.
if (newSessionId && resumeId) {
  console.error("--session-id and --resume passed on the same turn");
  process.exit(1);
}

const launchLog = Bun.env.COFORGE_GROK_LAUNCH_LOG;
if (launchLog) {
  await appendFile(
    launchLog,
    `${JSON.stringify({ prompt, rules, newSessionId, resumeId, model, effort, dir: Bun.env.PWD })}\n`,
  );
}

function write(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

// Same stdin-EOF reproduction as the OpenCode fixture (#652): a child spawned with an open stdin
// pipe hangs forever when the CLI waits for EOF; opt in so the adapter test proves the turn
// process closes stdin.
if (Bun.env.COFORGE_GROK_REQUIRE_STDIN_EOF === "1") {
  for await (const _chunk of Bun.stdin.stream()) {
    // Discard: nothing is being fed, the CLI is only waiting for the close.
  }
}

const sessionId = newSessionId ?? resumeId ?? crypto.randomUUID();
const mode = Bun.env.COFORGE_GROK_MODE ?? "text";
const turnDelayMs = Number(Bun.env.COFORGE_GROK_TURN_DELAY_MS ?? "0");
if (turnDelayMs > 0) await Bun.sleep(turnDelayMs);

if (mode === "hang") {
  process.on("SIGINT", () => process.exit(130));
  await new Promise(() => {});
}

// The session id Grok reports on `end`; the adapter pins it up front with `--session-id`, so the
// fixture reports the id it was given (a mismatching report is what "Grok replaced our id" would
// look like and the provider test covers it separately).
write({ type: "end", sessionId, stopReason: "endturn" });

if (mode === "text") {
  write({ type: "text", data: "hello from grok" });
  process.exit(0);
}
if (mode === "thinking") {
  write({ type: "thought", data: "thinking about it" });
  write({ type: "text", data: "answer" });
  write({ type: "end", sessionId, stopReason: "endturn" });
  process.exit(0);
}
if (mode === "stop") {
  write({ type: "end", sessionId, stopReason: "cancelled" });
  process.exit(0);
}
if (mode === "error") {
  write({ type: "error", message: Bun.env.COFORGE_GROK_ERROR ?? "boom" });
  process.exit(1);
}
process.exit(0);
