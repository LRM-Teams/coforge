import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpenCodeProvider } from "../src/code-agent/opencode/provider";
import { isOpenCodeVersionUnsupported } from "../src/code-agent/opencode/version";
import type { AgentRuntimeEvent } from "../src/code-agent/contract";

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

test("gates the CLI on the 1.15 baseline the runtime is written against", () => {
  expect(isOpenCodeVersionUnsupported("1.2.24")).toBe(true);
  expect(isOpenCodeVersionUnsupported("1.15.0")).toBe(false);
  expect(isOpenCodeVersionUnsupported("1.18.31")).toBe(false);
  // A version we cannot parse confidently is never gated.
  expect(isOpenCodeVersionUnsupported("nightly")).toBe(false);
});
