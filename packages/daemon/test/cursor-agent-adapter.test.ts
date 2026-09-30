import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSession } from "@coforge/agent";
import { CursorProvider } from "#src/code-agent/cursor/provider";
import type { AgentRuntimeEvent } from "#src/code-agent/contract";

const FIXTURE = new URL("./fixtures/cursor-agent-fixture.ts", import.meta.url).pathname;
const INSTRUCTIONS = "Standing Cursor instructions.";

function provider(): CursorProvider {
  return new CursorProvider({ command: [process.execPath, FIXTURE] });
}

async function readLaunches(
  log: string,
): Promise<Array<{ prompt: string; model?: string; resumeId?: string }>> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/** Resolves once `session` has emitted its Nth `completed` event. Registered before the input
 * that triggers it so no event can be missed to a race. */
function nthCompleted(
  session: { subscribe(listener: (event: AgentRuntimeEvent) => void): () => void },
  n: number,
): Promise<void> {
  return new Promise((resolve) => {
    let count = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "completed" && ++count >= n) {
        unsubscribe();
        resolve();
      }
    });
  });
}

test("a fresh session's first turn carries only the standing instructions, no --resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-fresh-"));
  const log = join(directory, "launches.jsonl");
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      environment: { COFORGE_CURSOR_MODE: "text", COFORGE_CURSOR_LAUNCH_LOG: log },
    });
    try {
      const identity = await session.readSessionIdentity!();
      expect(identity?.state).toBe("empty");
      const completed = nthCompleted(session, 1);
      // The bootstrap turn is already running by the time createAgentSession resolved.
      await completed;
      const launches = await readLaunches(log);
      expect(launches).toHaveLength(1);
      expect(launches[0]?.prompt).toBe(INSTRUCTIONS);
      expect(launches[0]?.resumeId).toBeUndefined();
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the first real message after bootstrap resumes the id the init frame reported", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-fresh-followup-"));
  const log = join(directory, "launches.jsonl");
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      environment: {
        COFORGE_CURSOR_MODE: "text",
        COFORGE_CURSOR_LAUNCH_LOG: log,
        COFORGE_CURSOR_SESSION_ID: "fresh-session-1",
      },
    });
    try {
      await nthCompleted(session, 1);
      await session.sendMessage("hello");
      await nthCompleted(session, 1);
      const launches = await readLaunches(log);
      expect(launches).toHaveLength(2);
      expect(launches[1]?.prompt).toBe("hello");
      expect(launches[1]?.resumeId).toBe("fresh-session-1");
      const identity = await session.readSessionIdentity!();
      expect(identity).toEqual({ sessionId: "fresh-session-1", state: "resumable" });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a resumed session spawns nothing until input arrives, then resumes the given id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-resume-"));
  const log = join(directory, "launches.jsonl");
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      sessionId: "existing-session",
      environment: { COFORGE_CURSOR_MODE: "text", COFORGE_CURSOR_LAUNCH_LOG: log },
    });
    try {
      expect(await session.readSessionIdentity!()).toEqual({
        sessionId: "existing-session",
        state: "resumable",
      });
      expect(await readLaunches(log)).toEqual([]);
      await session.sendMessage("continue");
      await nthCompleted(session, 1);
      const launches = await readLaunches(log);
      expect(launches).toHaveLength(1);
      expect(launches[0]?.prompt).toBe("continue");
      expect(launches[0]?.resumeId).toBe("existing-session");
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  ["default", undefined],
  ["", undefined],
  ["claude-opus-5-thinking-high", "claude-opus-5-thinking-high"],
] as const)("runtime.model %p is passed to argv as %p", async (model, expectedArgvModel) => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-model-"));
  const log = join(directory, "launches.jsonl");
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      sessionId: "existing-session",
      runtime: {
        provider: "cursor",
        model,
        reasoning: "",
      },
      environment: { COFORGE_CURSOR_MODE: "text", COFORGE_CURSOR_LAUNCH_LOG: log },
    });
    try {
      await session.sendMessage("go");
      await nthCompleted(session, 1);
      const launches = await readLaunches(log);
      expect(launches[0]?.model).toBe(expectedArgvModel);
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("queued sendMessage/notify while a turn runs coalesce into the next turn's prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-queue-"));
  const log = join(directory, "launches.jsonl");
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      sessionId: "existing-session",
      environment: {
        COFORGE_CURSOR_MODE: "text",
        COFORGE_CURSOR_LAUNCH_LOG: log,
        COFORGE_CURSOR_TURN_DELAY_MS: "150",
      },
    });
    try {
      const bothCompleted = nthCompleted(session, 2);
      const first = session.sendMessage("first");
      const second = session.notify!("second");
      const third = session.notify!("third");
      await first;
      await second;
      await third;
      await bothCompleted;
      const launches = await readLaunches(log);
      expect(launches).toHaveLength(2);
      expect(launches[0]?.prompt).toBe("first");
      expect(launches[1]?.prompt).toBe("second\n\nthird");
      expect(launches[1]?.resumeId).toBe("existing-session");
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("input queued behind a running turn resolves once the next turn has been spawned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-busy-"));
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      sessionId: "existing-session",
      environment: { COFORGE_CURSOR_MODE: "text", COFORGE_CURSOR_TURN_DELAY_MS: "150" },
    });
    try {
      const completed = nthCompleted(session, 1);
      const first = session.sendMessage("first");
      const queued = session.notify!("queued");
      await first;
      await completed;
      await queued;
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("thinking/text/tool_use content blocks in an assistant message map to their events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-blocks-"));
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      sessionId: "existing-session",
      environment: { COFORGE_CURSOR_MODE: "content-blocks" },
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.sendMessage("go");
      await nthCompleted(session, 1);
      const relevant = events.filter((event) =>
        ["thinking-delta", "text-delta", "tool-start", "completed"].includes(event.type),
      );
      expect(relevant).toEqual([
        { type: "thinking-delta", text: "considering the request" },
        {
          type: "tool-start",
          id: "tool-1",
          name: "shell",
          input: { command: "echo hi" },
          occurredAt: expect.any(String),
        },
        {
          type: "tool-start",
          id: expect.any(String),
          name: "unknown_tool",
          input: { path: "README.md" },
          occurredAt: expect.any(String),
        },
        // An empty text block carries no text-delta.
        { type: "text-delta", text: "done" },
        { type: "completed", status: "completed" },
      ]);
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("top-level Cursor thinking frames map to thinking activity events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-top-level-thinking-"));
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      sessionId: "existing-session",
      environment: { COFORGE_CURSOR_MODE: "top-level-thinking" },
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.sendMessage("go");
      await nthCompleted(session, 1);
      expect(
        events.some(
          (event) => event.type === "thinking-delta" && event.text === "thinking from cursor",
        ),
      ).toBe(true);
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("system status:compacting and compact_boundary map to compaction events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-compacting-"));
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      sessionId: "existing-session",
      environment: { COFORGE_CURSOR_MODE: "compacting" },
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.sendMessage("go");
      await nthCompleted(session, 1);
      expect(events.map((event) => event.type)).toEqual([
        "session",
        "compaction-started",
        "compaction-finished",
        "text-delta",
        "session",
        "completed",
      ]);
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an error result frame reports the joined errors[] and result text, then fails the turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-error-result-"));
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      sessionId: "existing-session",
      environment: { COFORGE_CURSOR_MODE: "error-result" },
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.sendMessage("go");
      await nthCompleted(session, 1);
      expect(events).toContainEqual({ type: "error", message: "Something broke | extra detail" });
      expect(events).toContainEqual({ type: "completed", status: "failed" });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a crash with no result frame surfaces the exit code and stderr reason", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-crash-"));
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      sessionId: "existing-session",
      environment: { COFORGE_CURSOR_MODE: "crash-no-result" },
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.sendMessage("go");
      await nthCompleted(session, 1);
      const error = events.find((event) => event.type === "error");
      expect(error?.type).toBe("error");
      expect((error as { message: string }).message).toContain("exit code 1");
      expect((error as { message: string }).message).toContain("ActionRequiredError");
      expect((error as { message: string }).message).toContain("Free plans can only use Auto");
      expect(events).toContainEqual({ type: "completed", status: "failed" });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a clean exit with no result frame completes the turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-silent-"));
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      sessionId: "existing-session",
      environment: { COFORGE_CURSOR_MODE: "silent-exit" },
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.sendMessage("go");
      await nthCompleted(session, 1);
      expect(events).toContainEqual({ type: "completed", status: "completed" });
      expect(events.some((event) => event.type === "error")).toBe(false);
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  [
    "a fresh turn with shell and read tools",
    "cursor-turn-fresh.jsonl",
    "f8d5b6d7-6f40-4225-a31f-b9b441015f0b",
    [
      { id: "call-0-shell", name: "bash", isError: false },
      { id: "call-1-read", name: "read_file", isError: true },
    ],
  ],
  [
    "a resumed turn that reconnects mid-turn",
    "cursor-turn-resume-reconnect.jsonl",
    "f8d5b6d7-6f40-4225-a31f-b9b441015f0b",
    [],
  ],
  [
    "a resume of an unknown id that silently starts a fresh chat",
    "cursor-turn-resume-unknown.jsonl",
    // Deliberately different from the fixture's own reported id - Cursor's real behavior for an
    // unknown `--resume` id (see the third case below).
    "unknown-id-requested",
    [],
  ],
] as const)(
  "measured real Cursor thinking and tool_call frames map to activity while unrelated frames stay ignored: %s",
  async (_name, fixtureFile, startingSessionId, expectedTools) => {
    const directory = await mkdtemp(join(tmpdir(), "cursor-replay-"));
    try {
      const session = await provider().createAgentSession({
        agentWorkspaceDirectory: directory,
        instructions: INSTRUCTIONS,
        sessionId: startingSessionId,
        environment: {
          COFORGE_CURSOR_MODE: "replay",
          COFORGE_CURSOR_REPLAY_FILE: new URL(`./fixtures/${fixtureFile}`, import.meta.url)
            .pathname,
        },
      });
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      try {
        await session.sendMessage("go");
        await nthCompleted(session, 1);
        // Top-level thinking deltas and `tool_call` frames are real provider progress and must
        // reach the activity trajectory. Connection/retry frames and the user echo remain internal.
        const contentEvents = events.filter((event) => event.type !== "session");
        expect(
          contentEvents.filter((event) => event.type === "thinking-delta").length,
        ).toBeGreaterThan(0);
        expect(contentEvents.filter((event) => event.type === "text-delta")).toHaveLength(2);
        const tools = contentEvents.flatMap((event) =>
          event.type === "tool-start" ? [{ id: event.id, name: event.name }] : [],
        );
        expect(
          tools.map((tool) => ({
            ...tool,
            isError: contentEvents.some(
              (event) => event.type === "tool-end" && event.id === tool.id && event.isError,
            ),
          })),
        ).toEqual([...expectedTools]);
        expect(contentEvents.filter((event) => event.type === "tool-end")).toHaveLength(
          expectedTools.length,
        );
        expect(contentEvents.at(-1)).toEqual({ type: "completed", status: "completed" });
      } finally {
        await session.dispose();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

/** Replays `replayFile` as one turn of a resumed session and returns every event the session
 * emitted. The subscription is made before the input that triggers the turn, so no event is
 * missed to a race. */
async function replayTurn(replayFile: string): Promise<AgentRuntimeEvent[]> {
  const directory = await mkdtemp(join(tmpdir(), "cursor-replay-tools-"));
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      sessionId: "4df1abf1-d91d-4e7b-8613-1f79686c2bb1",
      environment: { COFORGE_CURSOR_MODE: "replay", COFORGE_CURSOR_REPLAY_FILE: replayFile },
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      const completed = nthCompleted(session, 1);
      await session.sendMessage("go");
      await completed;
      return events;
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const isToolEvent = (event: AgentRuntimeEvent) =>
  event.type === "tool-start" || event.type === "tool-output" || event.type === "tool-end";

// Real `call_id`s: cursor-agent 2026.08.11 joins the call and the model's function-call id with a
// literal newline, so matching a completion to its start must not trim or split them.
const ECHO =
  "call-f2d0134c-0a6e-454c-b9d8-d3ea8dacb8ac-0\nfc_23359bd1-a752-90dd-b7ff-5eab346c3013_0";
const LS_MISSING =
  "call-f2d0134c-0a6e-454c-b9d8-d3ea8dacb8ac-1\nfc_23359bd1-a752-90dd-b7ff-5eab346c3013_1";
const READ_PRESENT =
  "call-f2d0134c-0a6e-454c-b9d8-d3ea8dacb8ac-2\nfc_23359bd1-a752-90dd-b7ff-5eab346c3013_2";
const READ_MISSING =
  "call-f2d0134c-0a6e-454c-b9d8-d3ea8dacb8ac-3\nfc_23359bd1-a752-90dd-b7ff-5eab346c3013_3";
const EDIT_FRUIT =
  "call-925c9113-295d-43c5-b62c-9395f599a69d-4\nfc_007ea4ad-f000-9814-8518-393133351771_0";
const GREP =
  "call-f311f6d1-10be-44ec-bd1b-00d99c70e155-0\nfc_e4358b29-fc00-9a4b-87f5-dad42fd2cb52_0";
const GLOB_MD =
  "call-f311f6d1-10be-44ec-bd1b-00d99c70e155-1\nfc_e4358b29-fc00-9a4b-87f5-dad42fd2cb52_1";
const GLOB_ALL =
  "call-f311f6d1-10be-44ec-bd1b-00d99c70e155-2\nfc_e4358b29-fc00-9a4b-87f5-dad42fd2cb52_2";
const READ_NOTES =
  "call-f048abc5-f075-439e-845e-0888418ebca3-4\nfc_bbb077e9-d1ce-9089-bd2f-34fbb5c28b5e_0";
const EDIT_NOTES =
  "call-be932be5-9894-431c-b1c7-c541ded5c0da-5\nfc_7c0b1a7f-24e2-9c63-a8ae-80f8a2b41ec9_0";

test("a real Cursor tool_call stream reports each call once, matched by call_id, with only the verified fields", async () => {
  // Trimmed from real cursor-agent 2026.08.11 captures (two turns, session ids unified): shell
  // success and failure, a read that failed and one that succeeded, edits, grep, and glob. The
  // frames of different calls interleave, and every `completed` frame carries its call's result -
  // stdout, file contents, diffs, `streamContent`, search hits - none of which may leave the
  // daemon beyond the shell/error output text asserted here.
  const events = await replayTurn(
    new URL("./fixtures/cursor-turn-tools.jsonl", import.meta.url).pathname,
  );
  expect(events.filter(isToolEvent)).toEqual([
    { type: "tool-start", id: ECHO, name: "bash", input: { command: "echo probe-ok" } },
    {
      type: "tool-start",
      id: LS_MISSING,
      name: "bash",
      input: { command: "ls /definitely-missing-dir" },
    },
    {
      type: "tool-start",
      id: READ_PRESENT,
      name: "read_file",
      input: { file_path: "/workspace/present.txt" },
    },
    {
      type: "tool-start",
      id: READ_MISSING,
      name: "read_file",
      input: { file_path: "/workspace/missing.txt" },
    },
    { type: "tool-output", id: READ_PRESENT, text: "File not found" },
    { type: "tool-end", id: READ_PRESENT, isError: true },
    { type: "tool-output", id: READ_MISSING, text: "File not found" },
    { type: "tool-end", id: READ_MISSING, isError: true },
    {
      type: "tool-output",
      id: LS_MISSING,
      text: "ls: /definitely-missing-dir: No such file or directory\n",
    },
    { type: "tool-end", id: LS_MISSING, isError: true },
    { type: "tool-output", id: ECHO, text: "probe-ok\n" },
    { type: "tool-end", id: ECHO, isError: false },
    {
      type: "tool-start",
      id: EDIT_FRUIT,
      name: "edit_file",
      input: { file_path: "/workspace/fruit.txt" },
    },
    { type: "tool-end", id: EDIT_FRUIT, isError: false },
    { type: "tool-start", id: GREP, name: "grep", input: { pattern: "probe-marker" } },
    { type: "tool-start", id: GLOB_MD, name: "glob", input: { pattern: "*.md" } },
    { type: "tool-start", id: GLOB_ALL, name: "glob", input: { pattern: "*" } },
    { type: "tool-end", id: GLOB_ALL, isError: false },
    { type: "tool-end", id: GREP, isError: false },
    { type: "tool-end", id: GLOB_MD, isError: false },
    { type: "tool-start", id: READ_NOTES, name: "read_file", input: { file_path: "notes.md" } },
    { type: "tool-end", id: READ_NOTES, isError: false },
    { type: "tool-start", id: EDIT_NOTES, name: "edit_file", input: { file_path: "notes.md" } },
    { type: "tool-end", id: EDIT_NOTES, isError: false },
  ]);
});

test("Cursor tool_call frames out of the ordinary still report one start and one end per call_id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-tool-frames-"));
  try {
    const frame = (
      subtype: "started" | "completed",
      callId: string | undefined,
      toolCall: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) => ({
      type: "tool_call",
      subtype,
      ...(callId ? { call_id: callId } : {}),
      tool_call: toolCall,
      session_id: "4df1abf1-d91d-4e7b-8613-1f79686c2bb1",
      timestamp_ms: 1,
      ...extra,
    });
    const shell = (command: string, result?: Record<string, unknown>) => ({
      shellToolCall: {
        args: { command, description: "must not travel" },
        ...(result && { result }),
      },
    });
    const frames = [
      // A completion whose start was never seen still opens the call first, from its own kind. A
      // failed read's completion carries no `args`.
      frame("completed", "orphan", {
        readToolCall: { result: { error: { errorMessage: "File not found" } } },
      }),
      // Repeats of a start or an end are the same call, not a second one.
      frame("started", "dup", shell("echo dup")),
      frame("started", "dup", shell("echo dup")),
      // A kind this daemon has no mapping for keeps its name, and reports nothing of its result.
      frame("started", "web", { webSearchToolCall: { args: { searchTerm: "coforge" } } }),
      frame(
        "completed",
        "dup",
        shell("echo dup", {
          success: { exitCode: 0, interleavedOutput: "dup\n" },
          isBackground: false,
        }),
      ),
      frame(
        "completed",
        "dup",
        shell("echo dup", { success: { exitCode: 0, interleavedOutput: "again\n" } }),
      ),
      frame("completed", "web", {
        webSearchToolCall: {
          args: { searchTerm: "coforge" },
          result: { success: { references: [{ title: "result-body-canary" }] } },
        },
      }),
      // Beside `failure` and `error`, the other non-`success` arms of a shell, read, edit, grep,
      // or glob result (`rejected`, `timeout`, `spawnError`, ...) are a call that did not run or
      // did not finish, and none of them has output text of its own.
      frame("started", "rejected", shell("rm -rf build")),
      frame("completed", "rejected", shell("rm -rf build", { rejected: { reason: "blocked" } })),
      // A completed shell frame can also carry a top-level `env` snapshot in the CLI's source;
      // nothing outside `tool_call.<kind>ToolCall.{args,result}` is read.
      frame("started", "envcall", shell("echo ok")),
      frame(
        "completed",
        "envcall",
        shell("echo ok", { success: { exitCode: 0, interleavedOutput: "ok\n" } }),
        { env: "SECRET_TOKEN=env-canary" },
      ),
      // Frames that cannot be matched to a call are not tool activity.
      frame("started", undefined, shell("echo nameless")),
      frame("started", "no-kind", { toolCallId: "no-kind" }),
    ];
    const replayFile = join(directory, "frames.jsonl");
    await Bun.write(
      replayFile,
      [
        { type: "system", subtype: "init", session_id: "4df1abf1-d91d-4e7b-8613-1f79686c2bb1" },
        ...frames,
        { type: "result", subtype: "success", is_error: false, result: "done", usage: {} },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    const events = await replayTurn(replayFile);
    expect(events.filter(isToolEvent)).toEqual([
      { type: "tool-start", id: "orphan", name: "read_file", input: {} },
      { type: "tool-output", id: "orphan", text: "File not found" },
      { type: "tool-end", id: "orphan", isError: true },
      { type: "tool-start", id: "dup", name: "bash", input: { command: "echo dup" } },
      { type: "tool-start", id: "web", name: "webSearch", input: { searchTerm: "coforge" } },
      { type: "tool-output", id: "dup", text: "dup\n" },
      { type: "tool-end", id: "dup", isError: false },
      { type: "tool-end", id: "web", isError: false },
      { type: "tool-start", id: "rejected", name: "bash", input: { command: "rm -rf build" } },
      { type: "tool-end", id: "rejected", isError: true },
      { type: "tool-start", id: "envcall", name: "bash", input: { command: "echo ok" } },
      { type: "tool-output", id: "envcall", text: "ok\n" },
      { type: "tool-end", id: "envcall", isError: false },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("interrupt() ends the running turn as interrupted and leaves the session usable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-interrupt-"));
  const log = join(directory, "launches.jsonl");
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      sessionId: "existing-session",
      environment: { COFORGE_CURSOR_MODE: "hang", COFORGE_CURSOR_LAUNCH_LOG: log },
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      const completed = nthCompleted(session, 1);
      void session.sendMessage("go");
      // Give the fixture a moment to actually start (write its init/user frames) before
      // interrupting, matching a real in-flight turn rather than a not-yet-spawned one.
      await Bun.sleep(50);
      await session.interrupt();
      await completed;
      expect(events).toContainEqual({ type: "completed", status: "interrupted" });
      // The session is idle again and accepts a new turn.
      const second = nthCompleted(session, 1);
      await session.sendMessage("go again");
      await Bun.sleep(50);
      await session.interrupt();
      await second;
      const launches = await readLaunches(log);
      expect(launches).toHaveLength(2);
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dispose kills a running turn and rejects queued input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-dispose-"));
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      sessionId: "existing-session",
      environment: { COFORGE_CURSOR_MODE: "hang" },
    });
    let exited = false;
    session.onExit(() => {
      exited = true;
    });
    try {
      void session.sendMessage("go");
      await Bun.sleep(50);
      const queued = session.notify!("queued while disposing");
      // Mark the rejection handled immediately so it never surfaces as an unhandled rejection
      // in the window between here and the assertion below.
      queued.catch(() => undefined);
      await session.dispose();
      expect(exited).toBe(true);
      await expect(queued).rejects.toThrow();
      await expect(session.sendMessage("after dispose")).rejects.toThrow();
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

type SessionReport = { sessionId: string; replacedSessionId?: string };

/** Runs `body` against a session in a fresh temporary workspace whose identity reports are
 * collected. */
async function withReportedSession(
  options: { sessionId?: string; environment?: Record<string, string> },
  body: (harness: {
    session: AgentSession;
    reports: SessionReport[];
    directory: string;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cursor-reports-"));
  const reports: SessionReport[] = [];
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      sessionId: options.sessionId,
      onSessionId: async (sessionId, replacedSessionId) => {
        reports.push(replacedSessionId ? { sessionId, replacedSessionId } : { sessionId });
      },
      environment: { COFORGE_CURSOR_MODE: "text", ...options.environment },
    });
    try {
      await body({ session, reports, directory });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Sends `text` and resolves once the turn it starts (or joins) has completed. */
async function completedTurn(session: AgentSession, text: string): Promise<void> {
  const completed = nthCompleted(session, 1);
  await session.sendMessage(text);
  await completed;
}

test("a turn that cannot be spawned rejects the input and leaves the session idle", async () => {
  await withReportedSession({ sessionId: "existing-session" }, async ({ session, directory }) => {
    // Bun.spawn throws synchronously for a working directory that does not exist.
    await rm(directory, { recursive: true });
    await expect(session.sendMessage("first")).rejects.toThrow("ENOENT");

    // The failed spawn did not leave the session "running": the next input starts a turn.
    await mkdir(directory);
    await completedTurn(session, "second");
  });
}, 5_000);

test("a resumed session reports its id when each turn names it and again when it completes", async () => {
  await withReportedSession({ sessionId: "existing-session" }, async ({ session, reports }) => {
    await completedTurn(session, "one");
    expect(reports).toHaveLength(2);
    await completedTurn(session, "two");
    expect(reports).toEqual(Array(4).fill({ sessionId: "existing-session" }));
    expect(await session.readSessionIdentity!()).toEqual({
      sessionId: "existing-session",
      state: "resumable",
    });
  });
});

test("a fresh session reports the id its init frame named, then again as each turn completes", async () => {
  await withReportedSession(
    { environment: { COFORGE_CURSOR_SESSION_ID: "fresh-session" } },
    async ({ session, reports }) => {
      await nthCompleted(session, 1);
      expect(reports).toEqual(Array(2).fill({ sessionId: "fresh-session" }));
      await completedTurn(session, "next");
      expect(reports).toEqual(Array(4).fill({ sessionId: "fresh-session" }));
    },
  );
});

test("a session whose first turn failed after naming it is re-derived as empty when its id repeats", async () => {
  await withReportedSession(
    {
      environment: {
        COFORGE_CURSOR_MODE: "crash-no-result",
        COFORGE_CURSOR_SESSION_ID: "half-session",
      },
    },
    async ({ session, reports }) => {
      await nthCompleted(session, 1);
      expect(await session.readSessionIdentity!()).toEqual({
        sessionId: "half-session",
        state: "empty",
      });
      expect(reports).toEqual([{ sessionId: "half-session" }]);
      // The next turn names the same id again: Cursor re-derives the state (the session never
      // completed a turn, so "empty") and reports the id once more.
      await completedTurn(session, "again");
      expect(await session.readSessionIdentity!()).toEqual({
        sessionId: "half-session",
        state: "empty",
      });
      expect(reports).toEqual(Array(2).fill({ sessionId: "half-session" }));
    },
  );
});

test("a resume Cursor answers under a different id adopts that id and reports it", async () => {
  // Cursor never fails a `--resume` of an unknown id: it starts a fresh chat under its own id.
  const adopted = "00000000-0000-0000-0000-000000000000";
  await withReportedSession(
    {
      sessionId: "unknown-id-requested",
      environment: {
        COFORGE_CURSOR_MODE: "replay",
        COFORGE_CURSOR_REPLAY_FILE: new URL(
          "./fixtures/cursor-turn-resume-unknown.jsonl",
          import.meta.url,
        ).pathname,
      },
    },
    async ({ session, reports }) => {
      await completedTurn(session, "go");
      expect(await session.readSessionIdentity!()).toEqual({
        sessionId: adopted,
        state: "resumable",
      });
      expect(reports).toEqual(Array(2).fill({ sessionId: adopted }));
    },
  );
});
