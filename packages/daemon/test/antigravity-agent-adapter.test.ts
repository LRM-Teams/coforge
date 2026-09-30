import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { AntigravityProvider } from "#src/code-agent/antigravity/provider";
import type { AgentRuntimeEvent } from "#src/code-agent/contract";
import { PROCESS_TREE_EXIT_GRACE_MS } from "#src/code-agent/process-tree-cleanup";
import { VERSION_PROBE_TIMEOUT_MS } from "#src/code-agent/version-gate";

const FIXTURE = new URL("./fixtures/antigravity-fixture.ts", import.meta.url).pathname;
const INSTRUCTIONS = "Standing Antigravity instructions.";
/** Each test runs the session's version probe, then turns of the fake agy that may end through the
 * process cleanup ladder. */
const SESSION_BUDGET_MS = VERSION_PROBE_TIMEOUT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS;

type Launch = { prompt: string; model?: string; conversation?: string };

async function readLaunches(log: string): Promise<Launch[]> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Launch);
}

/** Resolves once `session` has emitted its Nth `completed` event. Registered before the input
 * that triggers it so no event can be missed to a race. */
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

type SessionReport = { sessionId: string; replacedSessionId?: string };

/** Runs `body` against a session in a fresh temporary workspace whose launches are logged. */
async function withSession(
  options: {
    environment?: Record<string, string>;
    sessionId?: string;
    runtime?: AgentSessionOptions["runtime"];
  },
  body: (
    session: AgentSession,
    launches: () => Promise<Launch[]>,
    reports: SessionReport[],
  ) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "antigravity-"));
  const log = join(directory, "launches.jsonl");
  const reports: SessionReport[] = [];
  try {
    const session = await new AntigravityProvider({
      command: [process.execPath, FIXTURE],
    }).createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      sessionId: options.sessionId,
      runtime: options.runtime,
      onSessionId: async (sessionId, replacedSessionId) => {
        reports.push(replacedSessionId ? { sessionId, replacedSessionId } : { sessionId });
      },
      environment: {
        COFORGE_AGY_MODE: "text",
        COFORGE_AGY_LAUNCH_LOG: log,
        ...options.environment,
      },
    });
    try {
      await body(session, () => readLaunches(log), reports);
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test(
  "a fresh session's first turn carries only the standing instructions, with no --conversation",
  async () => {
    await withSession(
      { environment: { COFORGE_AGY_CONVERSATION_ID: "conv-1" } },
      async (session, launches) => {
        const completed = nthCompleted(session, 1);
        expect(await session.readSessionIdentity!()).toEqual({
          sessionId: "conv-1",
          state: "empty",
        });
        await completed;
        expect(await launches()).toEqual([{ prompt: INSTRUCTIONS }]);
        expect(await session.readSessionIdentity!()).toEqual({
          sessionId: "conv-1",
          state: "resumable",
        });
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "the next message resumes the conversation id the init frame reported",
  async () => {
    await withSession(
      { environment: { COFORGE_AGY_CONVERSATION_ID: "conv-2" } },
      async (session, launches) => {
        await nthCompleted(session, 1);
        await runTurn(session, "hello");
        expect((await launches())[1]).toEqual({ prompt: "hello", conversation: "conv-2" });
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "a resumed session spawns nothing until input arrives, then resumes the given id",
  async () => {
    await withSession({ sessionId: "existing" }, async (session, launches) => {
      expect(await session.readSessionIdentity!()).toEqual({
        sessionId: "existing",
        state: "resumable",
      });
      expect(await launches()).toEqual([]);
      await runTurn(session, "continue");
      expect(await launches()).toEqual([{ prompt: "continue", conversation: "existing" }]);
    });
  },
  SESSION_BUDGET_MS,
);

test(
  "a resumed id agy no longer has restarts fresh with the instructions, then the message",
  async () => {
    await withSession(
      {
        sessionId: "stale",
        environment: {
          COFORGE_AGY_LOST_CONVERSATION_ID: "stale",
          COFORGE_AGY_CONVERSATION_ID: "replacement",
        },
      },
      async (session, launches, reports) => {
        const events = record(session);
        const bothTurns = nthCompleted(session, 2);
        await session.sendMessage("are you there?");
        await bothTurns;
        expect(await launches()).toEqual([
          { prompt: "are you there?", conversation: "stale" },
          { prompt: INSTRUCTIONS },
          { prompt: "are you there?", conversation: "replacement" },
        ]);
        expect(await session.readSessionIdentity!()).toEqual({
          sessionId: "replacement",
          state: "resumable",
        });
        // The daemon learns of the replacement once, from the first report of the new id.
        expect(reports[0]).toEqual({ sessionId: "replacement", replacedSessionId: "stale" });
        expect(reports.slice(1).every((report) => !report.replacedSessionId)).toBe(true);
        // The discarded turn is not reported as a turn of its own.
        expect(events.filter((event) => event.type === "completed")).toEqual([
          { type: "completed", status: "completed" },
          { type: "completed", status: "completed" },
        ]);
      },
    );
  },
  SESSION_BUDGET_MS,
);

test.each([
  ["default", undefined],
  ["", undefined],
  ["gemini-3.8-flash-high", "gemini-3.8-flash-high"],
] as const)(
  "runtime.model %p is passed as --model %p",
  async (model, expected) => {
    await withSession(
      {
        sessionId: "existing",
        runtime: { provider: RUNTIME_PROVIDER.ANTIGRAVITY, model, reasoning: "" },
      },
      async (session, launches) => {
        await runTurn(session, "hi");
        expect((await launches())[0]?.model).toBe(expected);
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "a resumed turn reports its unchanged conversation once, when the turn completes",
  async () => {
    await withSession({ sessionId: "existing" }, async (session, _launches, reports) => {
      await runTurn(session, "hi");
      expect(reports).toEqual([{ sessionId: "existing" }]);
    });
  },
  SESSION_BUDGET_MS,
);

test(
  "agent_response text deltas stream in order and a stray non-JSON banner line is skipped",
  async () => {
    await withSession(
      { sessionId: "existing", environment: { COFORGE_AGY_BANNER: "[wrapper] starting agy" } },
      async (session) => {
        const events = await runTurn(session, "hi");
        expect(events.filter((event) => event.type === "text-delta")).toEqual([
          { type: "text-delta", text: "hello from " },
          { type: "text-delta", text: "antigravity\n" },
        ]);
        expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "tool steps map to tool-start, tool-output and tool-end once per step",
  async () => {
    await withSession(
      { sessionId: "existing", environment: { COFORGE_AGY_MODE: "tools" } },
      async (session) => {
        const events = await runTurn(session, "use tools");
        expect(events.filter((event) => event.type.startsWith("tool-"))).toEqual([
          {
            type: "tool-start",
            id: "existing:1",
            name: "run_command",
            input: { CommandLine: "echo probe-ok" },
          },
          { type: "tool-output", id: "existing:1", text: "probe-ok\n" },
          { type: "tool-end", id: "existing:1", isError: false },
          {
            type: "tool-start",
            id: "existing:2",
            name: "view_file",
            input: { AbsolutePath: "/missing" },
          },
          { type: "tool-output", id: "existing:2", text: "not found" },
          { type: "tool-end", id: "existing:2", isError: true },
        ]);
        expect(events.filter((event) => event.type === "text-delta")).toEqual([
          { type: "text-delta", text: "done\n" },
        ]);
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "an ERROR result reports its error and fails the turn",
  async () => {
    await withSession(
      { sessionId: "existing", environment: { COFORGE_AGY_MODE: "error-result" } },
      async (session) => {
        const events = await runTurn(session, "hi");
        const errors = events.filter((event) => event.type === "error");
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ type: "error", message: "model quota exhausted" });
        expect(events.at(-1)).toEqual({ type: "completed", status: "failed" });
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "a crash with no result frame surfaces the exit code and the stderr reason",
  async () => {
    await withSession(
      { sessionId: "existing", environment: { COFORGE_AGY_MODE: "crash-no-result" } },
      async (session) => {
        const events = await runTurn(session, "hi");
        const error = events.find((event) => event.type === "error");
        expect(error?.type === "error" && error.message).toContain("not signed in");
        expect(events.at(-1)).toEqual({ type: "completed", status: "failed" });
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "a clean exit with no result frame completes the turn",
  async () => {
    await withSession(
      { sessionId: "existing", environment: { COFORGE_AGY_MODE: "silent-exit" } },
      async (session) => {
        const events = await runTurn(session, "hi");
        expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "input queued while a turn runs is joined into the next turn's prompt",
  async () => {
    await withSession({ sessionId: "existing" }, async (session, launches) => {
      const both = nthCompleted(session, 2);
      // The first turn counts as running from the moment it is spawned, so the next two queue.
      await session.sendMessage("first");
      await Promise.all([session.sendMessage("second"), session.notify!("third")]);
      await both;
      expect((await launches()).map((launch) => launch.prompt)).toEqual([
        "first",
        "second\n\nthird",
      ]);
    });
  },
  SESSION_BUDGET_MS,
);

test(
  "interrupt() ends the running turn as interrupted, without reporting agy's INTERRUPTED result as an error",
  async () => {
    await withSession(
      { sessionId: "existing", environment: { COFORGE_AGY_MODE: "hang" } },
      async (session) => {
        const events = record(session);
        const completed = nthCompleted(session, 1);
        // The fake agy streams its first text once it can answer SIGINT with its result.
        const working = new Promise<void>((resolve) => {
          const off = session.subscribe((event) => {
            if (event.type === "text-delta") {
              off();
              resolve();
            }
          });
        });
        await session.sendMessage("hi");
        await working;
        await session.interrupt!();
        await completed;
        expect(events.filter((event) => event.type === "error")).toEqual([]);
        expect(events.at(-1)).toEqual({ type: "completed", status: "interrupted" });
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "dispose kills a running turn and rejects queued input",
  async () => {
    await withSession(
      { sessionId: "existing", environment: { COFORGE_AGY_MODE: "hang" } },
      async (session) => {
        await session.sendMessage("hi");
        const queued = session.sendMessage("later").then(
          () => "delivered",
          (error: Error) => error.message,
        );
        await session.dispose();
        expect(await queued).toBe("code agent session was disposed");
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "SSH session variables never reach the agy turn",
  async () => {
    await withSession(
      {
        sessionId: "existing",
        environment: { SSH_CLIENT: "10.0.0.1 1 22", SSH_TTY: "/dev/ttys001" },
      },
      async (session) => {
        // The fixture exits 1 if any SSH variable leaked.
        const events = await runTurn(session, "hi");
        expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });
      },
    );
  },
  SESSION_BUDGET_MS,
);
