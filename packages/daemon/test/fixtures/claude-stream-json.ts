import { appendFile } from "node:fs/promises";

const launchLogIndex = process.argv.indexOf("--launch-log");
if (launchLogIndex >= 0)
  await appendFile(
    process.argv[launchLogIndex + 1]!,
    `${process.argv.includes("--resume") ? "resume" : "fresh"}\n`,
  );

if (
  process.argv.includes("expect-resume") &&
  (process.argv[process.argv.indexOf("--resume") + 1] !== "selected-session" ||
    process.argv.includes("--no-session-persistence"))
)
  throw new Error("missing persistent explicit resume");

if (
  !process.argv.includes("--dangerously-skip-permissions") ||
  process.argv[process.argv.indexOf("--permission-mode") + 1] !== "bypassPermissions"
)
  throw new Error("missing approved Claude permission policy");

const resumeFlag = process.argv.indexOf("--resume");
const resumeId = resumeFlag < 0 ? undefined : process.argv[resumeFlag + 1];
const sessionIdFlag = process.argv.indexOf("--session-id");
const preallocatedSessionId = sessionIdFlag < 0 ? undefined : process.argv[sessionIdFlag + 1];
if (process.argv.includes("expected-new-session-id") && !preallocatedSessionId)
  throw new Error("fresh session ID was not preallocated");
const sessionId = resumeId ?? preallocatedSessionId ?? "fixture-session";
if (process.argv.includes("resume-missing")) {
  console.error(`No conversation found with session ID: ${resumeId}`);
  process.exit(1);
}
if (process.argv.includes("resume-auth-error")) {
  console.error("Authentication required");
  process.exit(1);
}
if (process.argv.includes("--no-session-persistence")) throw new Error("persistence disabled");
if (Bun.env.COFORGE_EXPECTED_SESSION) {
  if (
    resumeId !==
      (Bun.env.COFORGE_EXPECTED_SESSION === "new" ? undefined : Bun.env.COFORGE_EXPECTED_SESSION) ||
    Bun.env.HOME !== Bun.env.COFORGE_EXPECTED_HOME ||
    Bun.env.CLAUDE_CONFIG_DIR !== Bun.env.COFORGE_EXPECTED_CLAUDE_CONFIG_DIR ||
    process.cwd() !== Bun.env.COFORGE_EXPECTED_CWD
  )
    throw new Error("invalid native session configuration");
}
const promptFlag = process.argv.indexOf("--append-system-prompt-file");
if (promptFlag < 0) throw new Error("missing system prompt file option");
const promptPath = process.argv[promptFlag + 1];
if (!promptPath) throw new Error("missing system prompt file path");
const standingInstructions = await Bun.file(promptPath).text();
if (standingInstructions !== "Test Agent instructions.")
  throw new Error("missing Agent instructions");

const exitsOnInterrupt = process.argv.includes("exit-on-interrupt");
const decoder = new TextDecoder();
let buffer = "";
let inputSeen = false;
const eventFeed = Bun.env.COFORGE_CLAUDE_EVENT_FEED;
let feedStarted = false;
// Register interrupt handling before responding to initialization.
process.on("SIGINT", () => {
  if (exitsOnInterrupt) process.exit(130);
  write({ type: "result", subtype: "success" });
});
const initialization = {
  type: "system",
  subtype: "init",
  session_id: sessionId,
  models: [
    {
      value: "claude-sonnet-5",
      displayName: "Sonnet 5",
      description: "Fast and capable",
      supportedEffortLevels: ["low", "medium", "high"],
      defaultEffortLevel: "high",
    },
  ],
};
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line) as Record<string, unknown>);
    newline = buffer.indexOf("\n");
  }
}

function handle(record: Record<string, unknown>): void {
  if (record.type === "control_request") {
    const request = record.request as Record<string, unknown>;
    if (request.subtype !== "initialize") throw new Error("wrong startup request");
    if (process.argv.includes("missing-before-initialize") && process.argv.includes("--resume")) {
      const error = `No conversation found with session ID: ${process.argv[process.argv.indexOf("--resume") + 1]}`;
      console.error(error);
      write({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [error],
      });
      process.exit(1);
    }
    if (process.argv.includes("reject-initialize")) {
      write({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: record.request_id,
          error: "initialization rejected",
        },
      });
      return;
    }
    write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: record.request_id,
        response: {
          models: initialization.models,
          ...(process.argv.includes("missing-commands")
            ? {}
            : {
                commands: process.argv.includes("invalid-commands")
                  ? [{ name: "broken", description: 42 }]
                  : process.argv.includes("empty-commands")
                    ? []
                    : [
                        {
                          name: "fixture-skill",
                          description: "Fixture skill",
                          argumentHint: "",
                        },
                      ],
              }),
        },
      },
    });
    if (process.argv.includes("exit-after-init")) process.exit(1);
    return;
  }
  if (record.type === "user") {
    const message = record.message as Record<string, unknown>;
    if (process.argv.includes("missing-resume") && process.argv.includes("--resume")) {
      if (process.argv.includes("progress-before-missing"))
        write({ type: "stream_event", event: { type: "message_start" } });
      if (process.argv.includes("init-before-missing"))
        write({ ...initialization, session_id: "missing-session" });
      console.error(
        `No conversation found with session ID: ${process.argv[process.argv.indexOf("--resume") + 1]}`,
      );
      if (process.argv.includes("mixed-error")) console.error("EACCES: permission denied");
      if (process.argv.includes("invalid-output")) console.log("{broken JSON");
      process.exit(1);
    }
    if (process.argv.includes("fresh-fails") && !process.argv.includes("--resume")) {
      console.error("No conversation found with session ID: missing-session");
      process.exit(1);
    }
    if (process.argv.includes("resume-error")) {
      console.error(process.argv[process.argv.indexOf("resume-error") + 1]);
      process.exit(1);
    }
    if (record.session_id !== (inputSeen ? sessionId : (resumeId ?? preallocatedSessionId)))
      throw new Error("wrong session");
    const gate = !inputSeen && Bun.env.COFORGE_CLAUDE_INIT_GATE;
    inputSeen = true;
    if (gate) {
      void fetch(gate).then(() => {
        if (process.argv.includes("invalid-session-init")) {
          console.log(
            [
              {
                ...initialization,
                session_id: Bun.env.COFORGE_REPORTED_SESSION,
              },
              {
                type: "stream_event",
                event: {
                  type: "content_block_delta",
                  delta: { type: "text_delta", text: "wrong-session-output" },
                },
              },
              { type: "result", subtype: "success" },
            ]
              .map((value) => JSON.stringify(value))
              .join("\n"),
          );
          return;
        }
        write(initialization);
        inputObserved();
      });
      return;
    }
    if (
      process.argv.includes("mismatched-init") ||
      process.argv.includes("missing-init") ||
      process.argv.includes("invalid-init")
    ) {
      if (process.argv.includes("mismatched-init"))
        write({ ...initialization, session_id: "fixture-session" });
      if (process.argv.includes("invalid-init")) write({ ...initialization, session_id: "" });
      write({ type: "result", subtype: "success" });
      return;
    }
    write(initialization);
    if (process.argv.includes("--replay-user-messages") || record.uuid !== undefined)
      throw new Error("unexpected input replay protocol");
    if (eventFeed) inputObserved();
    if (message.content === "wait") return;
    if (message.content === "usage") {
      write({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: 1_788_490_800,
        },
      });
      write({ type: "result", subtype: "success" });
      return;
    }
    if (
      message.content !== "finish" &&
      message.content !== "New message available. Run coforge message check."
    )
      return;
    write({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Claude response" },
      },
    });
    write({
      type: "assistant",
      timestamp: "2026-01-02T03:04:05.000Z",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "printf safe" },
          },
        ],
      },
    });
    write({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "tests passed",
            is_error: false,
          },
        ],
      },
    });
    write({ type: "result", subtype: "success" });
    return;
  }
}

function inputObserved(): void {
  // Only the process that accepted the input consumes controlled events. A
  // failed resume must not leave an outstanding poll stealing fresh events.
  if (eventFeed && !feedStarted) {
    feedStarted = true;
    void (async () => {
      while (true) {
        const response = await fetch(eventFeed);
        const records = (await response.json()) as Record<string, unknown>[];
        for (const record of records) write(record);
      }
    })();
  }
  write({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "fixture-input-observed" },
    },
  });
}

function write(value: unknown): void {
  console.log(JSON.stringify(value));
}
