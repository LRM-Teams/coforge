import { expect, test } from "bun:test";

import { GrokProvider } from "../src/code-agent/grok/provider";
import { isGrokVersionUnsupported } from "../src/code-agent/grok/version";
import type { AgentRuntimeEvent } from "../src/code-agent/contract";

const FIXTURE = new URL("./fixtures/grok-fixture.ts", import.meta.url).pathname;
const INSTRUCTIONS = "Standing Grok instructions.";

function provider(): GrokProvider {
  return new GrokProvider({ command: [process.execPath, FIXTURE] });
}

type LaunchRecord = {
  prompt?: string;
  rules?: string;
  newSessionId?: string;
  resumeId?: string;
  model?: string;
  effort?: string;
  dir?: string;
};

async function readLaunches(log: string): Promise<LaunchRecord[]> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(log, "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LaunchRecord);
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

test("a fresh session pins its own session id on the first turn and resumes from the second", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "grok-adapter-"));
  const log = join(directory, "launches.jsonl");
  let session: Awaited<ReturnType<GrokProvider["createAgentSession"]>> | undefined;
  try {
    session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      environment: { COFORGE_GROK_LAUNCH_LOG: log, COFORGE_GROK_MODE: "text" },
    });
    const firstCompleted = nthCompleted(session, 1);
    // A fresh session spawns nothing until real input arrives (the standing instructions ride
    // `--rules`, so there is no instructions-only bootstrap turn).
    await session.sendMessage("do the thing");
    await firstCompleted;
    const identity = await session.readSessionIdentity!();
    expect(identity?.state).toBe("resumable");

    const secondCompleted = nthCompleted(session!, 1);
    await session.sendMessage("and more");
    await secondCompleted;

    const launches = await readLaunches(log);
    expect(launches).toHaveLength(2);
    const [first, second] = launches;
    expect(first!.newSessionId).toBe(identity?.sessionId);
    expect(first!.resumeId).toBeUndefined();
    expect(second!.newSessionId).toBeUndefined();
    expect(second!.resumeId).toBe(identity?.sessionId);
    // The standing instructions ride `--rules` on every turn (the system prompt is per
    // invocation), never the conversation body.
    expect(first!.prompt).toBe("do the thing");
    expect(first!.rules).toBe(INSTRUCTIONS);
    expect(second!.rules).toBe(INSTRUCTIONS);
    expect(first!.dir).toBe(directory);
  } finally {
    await session?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stream events map to the runtime contract: thought, text, end", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "grok-adapter-events-"));
  let session: Awaited<ReturnType<GrokProvider["createAgentSession"]>> | undefined;
  try {
    session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      environment: { COFORGE_GROK_MODE: "thinking" },
    });
    const events: AgentRuntimeEvent[] = [];
    const done = new Promise<void>((resolve) => {
      session!.subscribe((event) => {
        events.push(event);
        if (event.type === "completed") resolve();
      });
    });
    await session.sendMessage("go");
    await done;
    const thinking = events.find((event) => event.type === "thinking-delta");
    expect(thinking && "text" in thinking && thinking.text).toBe("thinking about it");
    const text = events.find((event) => event.type === "text-delta");
    expect(text && "text" in text && text.text).toBe("answer");
    expect(events.find((event) => event.type === "completed")?.status ?? "failed").toBe(
      "completed",
    );
  } finally {
    await session?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a cancelled stop reason fails the turn with its message", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "grok-adapter-stop-"));
  let session: Awaited<ReturnType<GrokProvider["createAgentSession"]>> | undefined;
  try {
    session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      environment: { COFORGE_GROK_MODE: "stop" },
    });
    const events: AgentRuntimeEvent[] = [];
    const done = new Promise<void>((resolve) => {
      session!.subscribe((event) => {
        events.push(event);
        if (event.type === "completed") resolve();
      });
    });
    await session.sendMessage("go");
    await done;
    const failure = events.find(
      (event) => event.type === "error" && "message" in event && event.message.includes("stopped"),
    );
    expect(failure).toBeDefined();
    expect(events.find((event) => event.type === "completed")?.status ?? "completed").toBe(
      "failed",
    );
  } finally {
    await session?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an error event fails the turn even when the process exits cleanly", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "grok-adapter-error-"));
  let session: Awaited<ReturnType<GrokProvider["createAgentSession"]>> | undefined;
  try {
    session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      environment: {
        COFORGE_GROK_MODE: "error",
        COFORGE_GROK_ERROR: "usage balance exhausted",
      },
    });
    const events: AgentRuntimeEvent[] = [];
    const done = new Promise<void>((resolve) => {
      session!.subscribe((event) => {
        events.push(event);
        if (event.type === "completed") resolve();
      });
    });
    await session.sendMessage("go");
    await done;
    const failure = events.find(
      (event) => event.type === "error" && "message" in event && event.message.includes("balance"),
    );
    expect(failure).toBeDefined();
    expect(events.find((event) => event.type === "completed")?.status ?? "completed").toBe(
      "failed",
    );
  } finally {
    await session?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the version gate rejects a confidently-parsed CLI below the baseline", () => {
  expect(isGrokVersionUnsupported("0.9.9")).toBe(true);
  expect(isGrokVersionUnsupported("1.0.0")).toBe(false);
  expect(isGrokVersionUnsupported("1.0.41")).toBe(false);
  // An unparseable version (a build hash) never gates.
  expect(isGrokVersionUnsupported("4220f3b224a6")).toBe(false);
});
