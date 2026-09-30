import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeEvent } from "#src/code-agent/contract";
import { GrokProvider } from "#src/code-agent/grok/provider";
import { isGrokVersionUnsupported } from "#src/code-agent/grok/version";
import { PROCESS_TREE_EXIT_GRACE_MS } from "#src/code-agent/process-tree-cleanup";
import { VERSION_PROBE_TIMEOUT_MS } from "#src/code-agent/version-gate";

const FIXTURE = new URL("./fixtures/grok-fixture.ts", import.meta.url).pathname;
const INSTRUCTIONS = "Standing Grok instructions.";
/** Each test runs the session's version probe, then turns of the fake grok that may end through
 * the process cleanup ladder. */
const SESSION_BUDGET_MS = VERSION_PROBE_TIMEOUT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS;
/** A session the fake grok already holds, the way a conversation from an earlier launch is. */
const EXISTING = "0195d5a0-4b2e-7c11-9a53-3f2f6b1d7e10";

type Launch = {
  prompt?: string;
  rules?: string;
  newSessionId?: string;
  resumeId?: string;
  model?: string;
  effort?: string;
  trust?: boolean;
  dir?: string;
};
type SessionReport = { sessionId: string; replacedSessionId?: string };

async function readLaunches(log: string): Promise<Launch[]> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Launch);
}

/** Resolves once `session` has emitted its Nth `completed` event. Registered before the input that
 * triggers it so no event can be missed to a race. */
function nthCompleted(session: AgentSession, n: number): Promise<void> {
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

function record(session: AgentSession): AgentRuntimeEvent[] {
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

/** Sends `text` as one turn and returns every event the session emitted until it completed. */
async function runTurn(session: AgentSession, text: string): Promise<AgentRuntimeEvent[]> {
  const events = record(session);
  const completed = nthCompleted(session, 1);
  await session.sendMessage(text);
  await completed;
  return events;
}

/** Resolves once `session` has streamed its first `text-delta`, the point at which the fake grok
 * can answer an interrupt. */
function firstText(session: AgentSession): Promise<void> {
  return new Promise((resolve) => {
    const off = session.subscribe((event) => {
      if (event.type === "text-delta") {
        off();
        resolve();
      }
    });
  });
}

type Harness = {
  session: AgentSession;
  launches: () => Promise<Launch[]>;
  reports: SessionReport[];
  workspace: string;
};

/** Runs `body` against a session in a fresh temporary workspace whose launches are logged and
 * whose fake grok already holds `existingSessions`. */
async function withSession(
  options: {
    environment?: Record<string, string>;
    sessionId?: string;
    sessionMode?: AgentSessionOptions["sessionMode"];
    existingSessions?: readonly string[];
    runtime?: AgentSessionOptions["runtime"];
  },
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "grok-adapter-"));
  const workspace = join(root, "workspace");
  const sessions = join(root, "sessions");
  const log = join(root, "launches.jsonl");
  const reports: SessionReport[] = [];
  try {
    await mkdir(workspace);
    for (const id of options.existingSessions ?? [])
      await mkdir(join(sessions, id), { recursive: true });
    await mkdir(sessions, { recursive: true });
    const session = await new GrokProvider({
      command: [process.execPath, FIXTURE],
    }).createAgentSession({
      agentWorkspaceDirectory: workspace,
      instructions: INSTRUCTIONS,
      sessionId: options.sessionId,
      sessionMode: options.sessionMode,
      runtime: options.runtime,
      onSessionId: async (sessionId, replacedSessionId) => {
        reports.push(replacedSessionId ? { sessionId, replacedSessionId } : { sessionId });
      },
      environment: {
        COFORGE_GROK_MODE: "text",
        COFORGE_GROK_LAUNCH_LOG: log,
        COFORGE_GROK_SESSIONS_DIR: sessions,
        ...options.environment,
      },
    });
    try {
      await body({ session, launches: () => readLaunches(log), reports, workspace });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test(
  "a fresh session pins its own session id on the first turn and resumes from the second",
  async () => {
    await withSession({}, async ({ session, launches }) => {
      // A fresh session spawns nothing until real input arrives (the standing instructions ride
      // `--rules`, so there is no instructions-only bootstrap turn).
      expect(await launches()).toEqual([]);
      expect(await session.readSessionIdentity!()).toMatchObject({ state: "empty" });
      await runTurn(session, "do the thing");
      const identity = await session.readSessionIdentity!();
      expect(identity?.state).toBe("resumable");
      await runTurn(session, "and more");

      const [first, second, ...rest] = await launches();
      expect(rest).toEqual([]);
      expect(first!.newSessionId).toBe(identity?.sessionId);
      expect(first!.resumeId).toBeUndefined();
      expect(second!.newSessionId).toBeUndefined();
      expect(second!.resumeId).toBe(identity?.sessionId);
      // The standing instructions ride `--rules` on every turn (the system prompt is per
      // invocation), never the conversation body.
      expect(first!.prompt).toBe("do the thing");
      expect(first!.rules).toBe(INSTRUCTIONS);
      expect(second!.rules).toBe(INSTRUCTIONS);
    });
  },
  SESSION_BUDGET_MS,
);

test(
  "a turn runs in the Agent workspace directory",
  async () => {
    await withSession({}, async ({ session, launches, workspace }) => {
      await runTurn(session, "hi");
      expect((await launches())[0]?.dir).toBe(workspace);
    });
  },
  SESSION_BUDGET_MS,
);

test(
  "stream events map to the runtime contract: thought, text, end",
  async () => {
    await withSession({ environment: { COFORGE_GROK_MODE: "thinking" } }, async ({ session }) => {
      const events = await runTurn(session, "go");
      expect(events.filter((event) => event.type === "thinking-delta")).toEqual([
        { type: "thinking-delta", text: "thinking about it" },
      ]);
      expect(events.filter((event) => event.type === "text-delta")).toEqual([
        { type: "text-delta", text: "answer" },
      ]);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });
    });
  },
  SESSION_BUDGET_MS,
);

test(
  "a cancelled stop reason fails the turn with its message",
  async () => {
    await withSession(
      { environment: { COFORGE_GROK_MODE: "end-reason", COFORGE_GROK_STOP_REASON: "cancelled" } },
      async ({ session }) => {
        const events = await runTurn(session, "go");
        expect(events.filter((event) => event.type === "error")).toEqual([
          { type: "error", message: "Grok stopped: cancelled" },
        ]);
        expect(events.at(-1)).toEqual({ type: "completed", status: "failed" });
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "an error frame fails the turn with its message",
  async () => {
    await withSession(
      {
        environment: { COFORGE_GROK_MODE: "error", COFORGE_GROK_ERROR: "usage balance exhausted" },
      },
      async ({ session }) => {
        const events = await runTurn(session, "go");
        expect(events.filter((event) => event.type === "error")).toEqual([
          { type: "error", message: "usage balance exhausted" },
        ]);
        expect(events.at(-1)).toEqual({ type: "completed", status: "failed" });
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "a crash with no frames surfaces the exit code and the stderr reason",
  async () => {
    await withSession({ environment: { COFORGE_GROK_MODE: "crash" } }, async ({ session }) => {
      const events = await runTurn(session, "go");
      const error = events.find((event) => event.type === "error");
      expect(error?.type === "error" && error.message).toContain("could not reach the xAI API");
      expect(events.at(-1)).toEqual({ type: "completed", status: "failed" });
    });
  },
  SESSION_BUDGET_MS,
);

test.each([
  ["default", undefined],
  ["", undefined],
  ["grok-4.6", "grok-4.6"],
] as const)(
  "runtime.model %p is passed as --model %p",
  async (model, expected) => {
    await withSession(
      { runtime: { provider: RUNTIME_PROVIDER.GROK, model, reasoning: "high" } },
      async ({ session, launches }) => {
        await runTurn(session, "hi");
        const [launch] = await launches();
        expect(launch?.model).toBe(expected);
        expect(launch?.effort).toBe("high");
      },
    );
  },
  SESSION_BUDGET_MS,
);

test("the version gate rejects a confidently-parsed CLI below the baseline", () => {
  expect(isGrokVersionUnsupported("0.9.9")).toBe(true);
  expect(isGrokVersionUnsupported("1.0.0")).toBe(false);
  expect(isGrokVersionUnsupported("1.0.41")).toBe(false);
  // An unparseable version (a build hash) never gates.
  expect(isGrokVersionUnsupported("4220f3b224a6")).toBe(false);
});
