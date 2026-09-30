import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSession } from "@coforge/agent";
import { OpenCodeProvider } from "#src/code-agent/opencode/provider";
import { isOpenCodeVersionUnsupported } from "#src/code-agent/opencode/version";
import type { AgentRuntimeEvent } from "#src/code-agent/contract";
import {
  RUNTIME_ERROR_CLASS,
  classifyRuntimeErrorText,
} from "#src/agent-runtime/runtime-error-classification";

const FIXTURE = new URL("./fixtures/opencode-fixture.ts", import.meta.url).pathname;
const INSTRUCTIONS = "Standing OpenCode instructions.";

function provider(): OpenCodeProvider {
  return new OpenCodeProvider({ command: [process.execPath, FIXTURE] });
}

async function readLaunches(
  log: string,
): Promise<Array<{ prompt: string; model?: string; variant?: string; resumeId?: string }>> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/** Resolves once `session` has emitted its Nth `completed` event. Registered before the input that
 * triggers it so no event can be missed to a race. */
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

test("a turn starts even though the CLI waits for stdin EOF before it emits anything", async () => {
  // s144, 2026-09-22: `opencode run` reads its piped stdin to EOF before starting, the spawned
  // child kept that pipe open, so no record ever arrived - `createAgentSession` never returned
  // and two OpenCode Agents sat Offline with hung turn processes (one per Start click).
  const directory = await mkdtemp(join(tmpdir(), "opencode-stdin-eof-"));
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      environment: { COFORGE_OPENCODE_MODE: "text", COFORGE_OPENCODE_REQUIRE_STDIN_EOF: "1" },
    });
    try {
      const completed = nthCompleted(session, 1);
      await completed;
      expect((await session.readSessionIdentity!())?.state).toBe("resumable");
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("a fresh session's first turn carries only the standing instructions, no --session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-fresh-"));
  const log = join(directory, "launches.jsonl");
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      environment: { COFORGE_OPENCODE_MODE: "text", COFORGE_OPENCODE_LAUNCH_LOG: log },
    });
    try {
      expect((await session.readSessionIdentity!())?.state).toBe("empty");
      const completed = nthCompleted(session, 1);
      // The bootstrap turn is already running by the time createAgentSession resolved.
      await completed;
      const launches = await readLaunches(log);
      expect(launches).toHaveLength(1);
      expect(launches[0]?.prompt).toBe(INSTRUCTIONS);
      expect(launches[0]?.resumeId).toBeUndefined();
      expect((await session.readSessionIdentity!())?.state).toBe("resumable");
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a later message resumes the session id OpenCode reported, with model and variant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-resume-"));
  const log = join(directory, "launches.jsonl");
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      runtime: {
        provider: "opencode",
        model: "opencode/big-pickle",
        reasoning: "high",
        modelProvider: "opencode",
      },
      environment: {
        COFORGE_OPENCODE_MODE: "text",
        COFORGE_OPENCODE_SESSION_ID: "session-abc",
        COFORGE_OPENCODE_TURN_DELAY_MS: "120",
        COFORGE_OPENCODE_LAUNCH_LOG: log,
      },
    });
    try {
      // Both completions, registered before any input so neither can be missed: the bootstrap turn
      // is still running, so this message queues behind it and becomes the turn that resumes.
      const bothCompleted = nthCompleted(session, 2);
      await session.sendMessage("do the thing");
      await bothCompleted;
      const launches = await readLaunches(log);
      expect(launches).toHaveLength(2);
      expect(launches[1]).toMatchObject({
        prompt: "do the thing",
        model: "opencode/big-pickle",
        variant: "high",
        resumeId: "session-abc",
      });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a resumed session spawns nothing until real input arrives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-resumed-"));
  const log = join(directory, "launches.jsonl");
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      sessionId: "session-existing",
      environment: { COFORGE_OPENCODE_MODE: "text", COFORGE_OPENCODE_LAUNCH_LOG: log },
    });
    try {
      expect(await readLaunches(log)).toHaveLength(0);
      const completed = nthCompleted(session, 1);
      await session.sendMessage("wake up");
      await completed;
      expect((await readLaunches(log))[0]).toMatchObject({
        prompt: "wake up",
        resumeId: "session-existing",
      });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("maps OpenCode's text and tool events onto the runtime contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-tool-"));
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      environment: { COFORGE_OPENCODE_MODE: "tool", COFORGE_OPENCODE_TURN_DELAY_MS: "120" },
    });
    try {
      const events: AgentRuntimeEvent[] = [];
      const completed = new Promise<void>((resolve) => {
        session.subscribe((event) => {
          events.push(event);
          if (event.type === "completed") resolve();
        });
      });
      await completed;
      expect(events.filter((event) => event.type === "tool-start")).toEqual([
        {
          type: "tool-start",
          id: "call-1",
          name: "bash",
          input: { command: "echo hi" },
          occurredAt: expect.any(String),
        },
      ]);
      expect(events).toContainEqual({ type: "tool-output", id: "call-1", text: "hi" });
      expect(events).toContainEqual({ type: "tool-end", id: "call-1", isError: false });
      expect(events).toContainEqual({ type: "text-delta", text: "done" });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an error event fails the turn with OpenCode's own message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-error-"));
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      environment: { COFORGE_OPENCODE_MODE: "error-event", COFORGE_OPENCODE_TURN_DELAY_MS: "120" },
    });
    try {
      const events: AgentRuntimeEvent[] = [];
      const completed = new Promise<void>((resolve) => {
        session.subscribe((event) => {
          events.push(event);
          if (event.type === "completed") resolve();
        });
      });
      await completed;
      expect(events).toContainEqual({
        type: "error",
        message: "no credentials for provider opencode",
      });
      expect(events).toContainEqual({ type: "completed", status: "failed" });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a provider quota failure surfaces its kind, status and message, not a bare label", async () => {
  // 2026-09-23: OpenCode Zen exhausted its pool and every turn ended as an unexplainable
  // "Agent runtime failed." because the envelope's cause rode fields the adapter never read.
  // The surfaced text must carry the classification the operator needs to act on.
  const directory = await mkdtemp(join(tmpdir(), "opencode-quota-"));
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      environment: {
        COFORGE_OPENCODE_MODE: "provider-quota",
        COFORGE_OPENCODE_TURN_DELAY_MS: "120",
      },
    });
    try {
      const events: AgentRuntimeEvent[] = [];
      const completed = new Promise<void>((resolve) => {
        session.subscribe((event) => {
          events.push(event);
          if (event.type === "completed") resolve();
        });
      });
      await completed;
      expect(events).toContainEqual({
        type: "error",
        message: "provider.quota (HTTP 429): Rate limit exceeded. Please try again later.",
      });
      expect(events).toContainEqual({ type: "completed", status: "failed" });
      // The surfaced text is what the daemon classifies on — pin the classification itself, not
      // just the string, so rewording the prefix cannot silently demote the rate_limited class
      // (and its retry decision) back to generic.
      const error = events.find((event) => event.type === "error");
      const surfaced = error && error.type === "error" ? error.message : "";
      expect(classifyRuntimeErrorText(surfaced).errorClass).toBe(RUNTIME_ERROR_CLASS.RATE_LIMIT);
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unfamiliar error envelope still fails the turn with a non-empty message", async () => {
  // A shape the adapter never met must degrade to words, never to an empty string — an empty
  // reason is the same disease as the "Agent runtime failed." this fix removes; the exit code
  // rides the separately-tested `exitFailureMessage` path when no event explains the exit.
  const directory = await mkdtemp(join(tmpdir(), "opencode-opaque-"));
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      environment: { COFORGE_OPENCODE_MODE: "opaque-error", COFORGE_OPENCODE_TURN_DELAY_MS: "120" },
    });
    try {
      const events: AgentRuntimeEvent[] = [];
      const completed = new Promise<void>((resolve) => {
        session.subscribe((event) => {
          events.push(event);
          if (event.type === "completed") resolve();
        });
      });
      await completed;
      const error = events.find((event) => event.type === "error");
      expect(error && error.type === "error" ? error.message.trim() : "").not.toBe("");
      expect(events).toContainEqual({ type: "completed", status: "failed" });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a non-zero exit fails the turn with its exit code and stderr tail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-crash-"));
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      environment: { COFORGE_OPENCODE_MODE: "crash" },
    });
    try {
      const events: AgentRuntimeEvent[] = [];
      const completed = new Promise<void>((resolve) => {
        session.subscribe((event) => {
          events.push(event);
          if (event.type === "completed") resolve();
        });
      });
      await completed;
      const error = events.find((event) => event.type === "error");
      expect(error).toMatchObject({ type: "error" });
      expect(error && error.type === "error" ? error.message : "").toContain(
        "exit code 1 | stderr: Error: model not found: opencode/nope",
      );
      expect(events).toContainEqual({ type: "completed", status: "failed" });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("interrupting a running turn ends it as interrupted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-interrupt-"));
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      environment: { COFORGE_OPENCODE_MODE: "hang" },
    });
    try {
      // `createAgentSession` resolved on this session's own first event, so the hang turn is
      // already running; interrupting it must end the turn as `interrupted`.
      const completed = new Promise<void>((resolve) => {
        session.subscribe((event) => {
          if (event.type === "completed") resolve();
        });
      });
      await session.interrupt();
      await completed;
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Sends `text` and resolves once the turn it starts (or joins) has completed. */
async function nthTurn(session: AgentSession, text: string): Promise<void> {
  const completed = nthCompleted(session, 1);
  await session.sendMessage(text);
  await completed;
}

type SessionReport = { sessionId: string; replacedSessionId?: string };

/** Runs `body` against a session in a fresh temporary workspace whose launches are logged and
 * whose identity reports are collected. */
async function withSession(
  options: { sessionId?: string; environment?: Record<string, string> },
  body: (harness: {
    session: AgentSession;
    launches: () => Promise<Awaited<ReturnType<typeof readLaunches>>>;
    reports: SessionReport[];
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-session-"));
  const log = join(directory, "launches.jsonl");
  const reports: SessionReport[] = [];
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      sessionId: options.sessionId,
      onSessionId: async (sessionId, replacedSessionId) => {
        reports.push(replacedSessionId ? { sessionId, replacedSessionId } : { sessionId });
      },
      environment: {
        COFORGE_OPENCODE_MODE: "text",
        COFORGE_OPENCODE_LAUNCH_LOG: log,
        ...options.environment,
      },
    });
    try {
      await body({ session, launches: () => readLaunches(log), reports });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Resolves once `session` has emitted its first `progress` event, the point at which a fake
 * opencode turn is running and (in `hang` mode) can answer an interrupt. */
function firstProgress(session: AgentSession): Promise<void> {
  return new Promise((resolve) => {
    const off = session.subscribe((event) => {
      if (event.type === "progress") {
        off();
        resolve();
      }
    });
  });
}

test("input queued while a turn runs is joined into the next turn's prompt", async () => {
  await withSession(
    {
      sessionId: "session-existing",
      environment: { COFORGE_OPENCODE_TURN_DELAY_MS: "150" },
    },
    async ({ session, launches }) => {
      const both = nthCompleted(session, 2);
      // The first turn counts as running from the moment it is spawned, so the next two queue.
      await session.sendMessage("first");
      await Promise.all([session.sendMessage("second"), session.notify!("third")]);
      await both;
      const [first, second, ...rest] = await launches();
      expect(rest).toEqual([]);
      expect(first?.prompt).toBe("first");
      expect(second).toMatchObject({ prompt: "second\n\nthird", resumeId: "session-existing" });
    },
  );
}, 20_000);

test("interrupting a running turn ends it as interrupted and leaves the session usable", async () => {
  await withSession(
    { sessionId: "session-existing", environment: { COFORGE_OPENCODE_MODE: "hang" } },
    async ({ session, launches }) => {
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      for (let turn = 1; turn <= 2; turn += 1) {
        const running = firstProgress(session);
        const completed = nthCompleted(session, 1);
        await session.sendMessage("go");
        await running;
        await session.interrupt();
        await completed;
      }
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(events.filter((event) => event.type === "completed")).toEqual([
        { type: "completed", status: "interrupted" },
        { type: "completed", status: "interrupted" },
      ]);
      expect(await launches()).toHaveLength(2);
    },
  );
}, 20_000);

test("dispose kills a running turn and rejects queued input", async () => {
  await withSession(
    { sessionId: "session-existing", environment: { COFORGE_OPENCODE_MODE: "hang" } },
    async ({ session }) => {
      let exited = false;
      session.onExit(() => {
        exited = true;
      });
      const running = firstProgress(session);
      await session.sendMessage("go");
      await running;
      const queued = session.notify!("queued while disposing");
      // Mark the rejection handled at once, so it never surfaces as unhandled before the assertion.
      queued.catch(() => undefined);
      await session.dispose();
      expect(exited).toBe(true);
      await expect(queued).rejects.toThrow("code agent session was disposed");
      await expect(session.sendMessage("after dispose")).rejects.toThrow(
        "code agent session is disposed",
      );
    },
  );
}, 20_000);

test("a resumed session reports its id when each turn completes, and only then", async () => {
  await withSession({ sessionId: "session-existing" }, async ({ session, reports }) => {
    await nthTurn(session, "one");
    expect(await session.readSessionIdentity!()).toEqual({
      sessionId: "session-existing",
      state: "resumable",
    });
    await nthTurn(session, "two");
    expect(reports).toEqual([{ sessionId: "session-existing" }, { sessionId: "session-existing" }]);
  });
}, 20_000);

test("a fresh session reports the id its first event named, then again as each turn completes", async () => {
  await withSession(
    { environment: { COFORGE_OPENCODE_SESSION_ID: "session-fresh" } },
    async ({ session, reports }) => {
      await nthCompleted(session, 1);
      // The bootstrap turn named the session (one report) and then completed (a second).
      expect(reports).toEqual([{ sessionId: "session-fresh" }, { sessionId: "session-fresh" }]);
      await nthTurn(session, "next");
      expect(reports).toHaveLength(3);
    },
  );
}, 20_000);

test("a session whose first turn failed after naming it stays unknown, and a repeat of its id is not reported", async () => {
  await withSession(
    {
      environment: { COFORGE_OPENCODE_MODE: "crash", COFORGE_OPENCODE_SESSION_ID: "session-half" },
    },
    async ({ session, reports }) => {
      await nthCompleted(session, 1);
      expect(await session.readSessionIdentity!()).toEqual({
        sessionId: "session-half",
        state: "empty",
      });
      // The next turn repeats the id the session already has: it is not re-derived (the session
      // never completed a turn, yet stays "unknown" as the resume marked it) and not re-reported.
      await nthTurn(session, "again");
      expect(await session.readSessionIdentity!()).toEqual({
        sessionId: "session-half",
        state: "unknown",
      });
      expect(reports).toEqual([{ sessionId: "session-half" }]);
    },
  );
}, 20_000);

test("gates the CLI on the OpenCode v2 runtime contract", () => {
  expect(isOpenCodeVersionUnsupported("1.18.31")).toBe(true);
  expect(isOpenCodeVersionUnsupported("2.0.0")).toBe(false);
  expect(isOpenCodeVersionUnsupported("2.0.7")).toBe(false);
  // A version we cannot parse confidently is never gated.
  expect(isOpenCodeVersionUnsupported("nightly")).toBe(false);
});
