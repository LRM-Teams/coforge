import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CursorProvider } from "../src/code-agent/cursor/provider";
import type { AgentRuntimeEvent } from "../src/code-agent/contract";

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
  ],
  [
    "a resumed turn that reconnects mid-turn",
    "cursor-turn-resume-reconnect.jsonl",
    "f8d5b6d7-6f40-4225-a31f-b9b441015f0b",
  ],
  [
    "a resume of an unknown id that silently starts a fresh chat",
    "cursor-turn-resume-unknown.jsonl",
    // Deliberately different from the fixture's own reported id - Cursor's real behavior for an
    // unknown `--resume` id (see the third case below).
    "unknown-id-requested",
  ],
] as const)(
  "measured real frames beyond system/init, assistant, and result are ignored: %s",
  async (_name, fixtureFile, startingSessionId) => {
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
        // The real `thinking`, `tool_call`, `connection`, and `retry` frames these captures
        // contain, and the `user` echo of the prompt, produce nothing: only identity from
        // `system/init`, the two `assistant` text blocks, and the terminal `completed` remain.
        const contentEvents = events.filter((event) => event.type !== "session");
        expect(contentEvents.map((event) => event.type)).toEqual([
          "text-delta",
          "text-delta",
          "completed",
        ]);
        expect(contentEvents[contentEvents.length - 1]).toEqual({
          type: "completed",
          status: "completed",
        });
      } finally {
        await session.dispose();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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
