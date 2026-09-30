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
import { captureDaemonLogs } from "./log-capture";

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
  "every turn trusts the Agent workspace so its skills and project instructions load",
  async () => {
    // 22-permissions-and-safety.md: headless startup loads project skills and instructions only for
    // a trusted folder, and `--trust` grants it. The assigned skills are installed in the Agent
    // workspace, so a turn without `--trust` would never see them.
    await withSession({}, async ({ session, launches }) => {
      await runTurn(session, "first");
      await runTurn(session, "second");
      const turns = await launches();
      expect(turns).toHaveLength(2);
      expect(turns.map((turn) => turn.trust)).toEqual([true, true]);
    });
  },
  SESSION_BUDGET_MS,
);

test(
  "a turn never waits on stdin: the fake grok that reads it to EOF still finishes",
  async () => {
    await withSession(
      { environment: { COFORGE_GROK_REQUIRE_STDIN_EOF: "1" } },
      async ({ session }) => {
        const events = await runTurn(session, "go");
        expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });
      },
    );
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

test(
  "an error frame does not turn a turn that then ends with end_turn into a success",
  async () => {
    await withSession(
      {
        environment: {
          COFORGE_GROK_MODE: "error-then-end",
          COFORGE_GROK_ERROR: "usage balance exhausted",
        },
      },
      async ({ session }) => {
        const events = await runTurn(session, "go");
        expect(events.filter((event) => event.type === "error")).toEqual([
          { type: "error", message: "usage balance exhausted" },
        ]);
        // The clean exit and the closing `end_turn` do not undo the failure the error frame named.
        expect(events.at(-1)).toEqual({ type: "completed", status: "failed" });
      },
    );
  },
  SESSION_BUDGET_MS,
);

test.each([
  ["max_turn_requests", "Grok reached max turns"],
  ["max_tokens", "Grok stopped: the response reached the output token limit (max_tokens)"],
  ["refusal", "Grok stopped: the model refused to continue (refusal)"],
] as const)(
  "an end with stop reason %s fails the turn with an explanation",
  async (stopReason, message) => {
    // 14-headless-mode.md lists `end.stopReason` as end_turn, max_tokens, max_turn_requests,
    // refusal or cancelled; only end_turn is a success.
    await withSession(
      { environment: { COFORGE_GROK_MODE: "end-reason", COFORGE_GROK_STOP_REASON: stopReason } },
      async ({ session }) => {
        const events = await runTurn(session, "go");
        expect(events.filter((event) => event.type === "error")).toEqual([
          { type: "error", message },
        ]);
        expect(events.at(-1)).toEqual({ type: "completed", status: "failed" });
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "interrupt() ends the running turn as interrupted, without reporting grok's cancelled end as an error",
  async () => {
    await withSession({ environment: { COFORGE_GROK_MODE: "hang" } }, async ({ session }) => {
      const events = record(session);
      const working = firstText(session);
      const completed = nthCompleted(session, 1);
      await session.sendMessage("hi");
      // The fake grok answers SIGINT once it has streamed its first text.
      await working;
      await session.interrupt!();
      await completed;
      // The interrupt is the requested stop: neither the `cancelled` end nor the error frame that
      // came with it is a runtime error.
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(events.at(-1)).toEqual({ type: "completed", status: "interrupted" });
    });
  },
  SESSION_BUDGET_MS,
);

test(
  "tool_call and tool_call_update map to tool-start, tool-output and tool-end once per call",
  async () => {
    await withSession({ environment: { COFORGE_GROK_MODE: "tools" } }, async ({ session }) => {
      const events = await runTurn(session, "use tools");
      // The name is grok's own tool name and the input its `rawInput`: the daemon core decides
      // what Activity a tool call is. Only a string `rawOutput` is output text; the guide shows an
      // object (`{"lines":42}`) for a read and says nothing of the content array's elements.
      expect(events.filter((event) => event.type.startsWith("tool-"))).toEqual([
        { type: "tool-start", id: "call_1", name: "read_file", input: { path: "src/main.rs" } },
        { type: "tool-end", id: "call_1", isError: false },
        {
          type: "tool-start",
          id: "call_2",
          name: "run_terminal_command",
          input: { command: "false" },
        },
        { type: "tool-output", id: "call_2", text: "command exited with status 1" },
        { type: "tool-end", id: "call_2", isError: true },
        { type: "tool-start", id: "call_3", name: "grep", input: { pattern: "main" } },
        { type: "tool-end", id: "call_3", isError: false },
      ]);
      expect(events.filter((event) => event.type === "text-delta")).toEqual([
        { type: "text-delta", text: "done" },
      ]);
      expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });
    });
  },
  SESSION_BUDGET_MS,
);

test(
  "documented frames the adapter has no use for are not logged as unrecognized",
  async () => {
    const { records } = await captureDaemonLogs(async () => {
      await withSession(
        {
          environment: {
            COFORGE_GROK_MODE: "documented-frames",
            COFORGE_GROK_UNKNOWN_FRAME: "mystery",
          },
        },
        async ({ session }) => {
          const events = await runTurn(session, "go");
          expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });
        },
      );
    });
    // available_commands, plan, usage and auto_compact_* are in the guide; only a type it does not
    // list is worth a warning.
    const unrecognized = records.filter(
      (entry) => entry.properties.event === "code_agent.grok.unknown_event",
    );
    expect(unrecognized.map((entry) => entry.properties.type)).toEqual(["mystery"]);
  },
  SESSION_BUDGET_MS,
);

test.each([
  ["fails with an error frame", { COFORGE_GROK_NEW_SESSION_MODE: "error" }],
  ["crashes before any frame", { COFORGE_GROK_NEW_SESSION_MODE: "crash" }],
])(
  "a first turn that %s still leaves the session created, so the next turn resumes it",
  async (_outcome, environment) => {
    // Grok creates the session before the turn can fail, and refuses `--session-id` for an id
    // that exists ("already in use"), so once a turn has been spawned with `--session-id` every
    // later turn must `--resume`, whatever that turn's outcome was.
    await withSession({ environment }, async ({ session, launches }) => {
      const failed = await runTurn(session, "first");
      expect(failed.at(-1)).toEqual({ type: "completed", status: "failed" });
      const next = await runTurn(session, "second");
      expect(next.filter((event) => event.type === "error")).toEqual([]);
      expect(next.at(-1)).toEqual({ type: "completed", status: "completed" });

      const [first, second] = await launches();
      expect(first?.newSessionId).toBeDefined();
      expect(second?.resumeId).toBe(first?.newSessionId);
      expect(second?.newSessionId).toBeUndefined();
    });
  },
  SESSION_BUDGET_MS,
);

test(
  "an interrupted first turn leaves the session created, so the next turn resumes it",
  async () => {
    await withSession(
      { environment: { COFORGE_GROK_NEW_SESSION_MODE: "hang" } },
      async ({ session, launches }) => {
        const working = firstText(session);
        await session.sendMessage("first");
        await working;
        const interrupted = nthCompleted(session, 1);
        await session.interrupt!();
        await interrupted;

        const next = await runTurn(session, "second");
        expect(next.at(-1)).toEqual({ type: "completed", status: "completed" });
        const [first, second] = await launches();
        expect(second?.resumeId).toBe(first?.newSessionId);
        expect(second?.newSessionId).toBeUndefined();
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "a resumed session spawns nothing until input arrives, then resumes the given id",
  async () => {
    await withSession(
      { sessionId: EXISTING, existingSessions: [EXISTING] },
      async ({ session, launches }) => {
        expect(await session.readSessionIdentity!()).toEqual({
          sessionId: EXISTING,
          state: "unknown",
        });
        expect(await launches()).toEqual([]);
        await runTurn(session, "continue");
        const [launch, ...rest] = await launches();
        expect(rest).toEqual([]);
        expect(launch).toMatchObject({ prompt: "continue", resumeId: EXISTING });
        expect(launch?.newSessionId).toBeUndefined();
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "a session id the daemon asks to create is pinned with --session-id, then resumed",
  async () => {
    const id = "0195d5a0-4b2e-7c11-9a53-3f2f6b1d7e11";
    await withSession({ sessionId: id, sessionMode: "create" }, async ({ session, launches }) => {
      expect(await session.readSessionIdentity!()).toEqual({ sessionId: id, state: "empty" });
      await runTurn(session, "first");
      await runTurn(session, "second");
      const [first, second] = await launches();
      expect(first?.newSessionId).toBe(id);
      expect(first?.resumeId).toBeUndefined();
      expect(second?.resumeId).toBe(id);
      expect(second?.newSessionId).toBeUndefined();
    });
  },
  SESSION_BUDGET_MS,
);

test(
  "a resumed id grok no longer has restarts as a fresh session with the same input",
  async () => {
    const stale = "0195d5a0-4b2e-7c11-9a53-3f2f6b1d7e12";
    await withSession({ sessionId: stale }, async ({ session, launches, reports }) => {
      const events = await runTurn(session, "are you there?");
      const [attempt, retry, ...rest] = await launches();
      expect(rest).toEqual([]);
      expect(attempt).toMatchObject({ prompt: "are you there?", resumeId: stale });
      // The standing instructions ride `--rules` on every turn, so the fresh session needs no
      // bootstrap turn: it is the same input, pinned under a new id.
      expect(retry).toMatchObject({ prompt: "are you there?", rules: INSTRUCTIONS });
      expect(retry?.resumeId).toBeUndefined();
      const replacement = retry?.newSessionId;
      expect(replacement).toBeDefined();
      expect(replacement).not.toBe(stale);
      expect(await session.readSessionIdentity!()).toEqual({
        sessionId: replacement!,
        state: "resumable",
      });
      // The discarded attempt is neither an error nor a turn of its own.
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(events.filter((event) => event.type === "completed")).toEqual([
        { type: "completed", status: "completed" },
      ]);

      // The daemon learns of the replacement once, so it invalidates the stale id.
      await runTurn(session, "again");
      expect((await launches())[2]?.resumeId).toBe(replacement);
      expect(reports).toEqual([{ sessionId: replacement!, replacedSessionId: stale }]);
    });
  },
  SESSION_BUDGET_MS,
);

test(
  "a lost session whose replacement cannot be spawned fails the turn visibly and recovers",
  async () => {
    const stale = "0195d5a0-4b2e-7c11-9a53-3f2f6b1d7e13";
    await withSession(
      { sessionId: stale, environment: { COFORGE_GROK_REMOVE_WORKSPACE: "1" } },
      async ({ session, launches, workspace }) => {
        const events = await runTurn(session, "hi");
        const error = events.find((event) => event.type === "error");
        expect(error?.type === "error" && error.message).toContain("ENOENT");
        expect(events.at(-1)).toEqual({ type: "completed", status: "failed" });
        expect(await launches()).toHaveLength(1);

        // The replacement id was never created, so the next turn pins it.
        await mkdir(workspace);
        const next = await runTurn(session, "again");
        expect(next.at(-1)).toEqual({ type: "completed", status: "completed" });
        const [, second] = await launches();
        expect(second?.newSessionId).toBeDefined();
        expect(second?.newSessionId).not.toBe(stale);
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "a resume that fails for any other reason fails the turn instead of restarting the session",
  async () => {
    // Both phrases of grok's missing-session message are required; a stderr that names only one
    // is some other restore failure, and starting a new session over it would lose a live one.
    await withSession(
      {
        sessionId: EXISTING,
        existingSessions: [EXISTING],
        environment: {
          COFORGE_GROK_MODE: "crash",
          COFORGE_GROK_CRASH_STDERR: "Error: Failed to restore session from remote: 503",
        },
      },
      async ({ session, launches, reports }) => {
        const events = await runTurn(session, "hi");
        const error = events.find((event) => event.type === "error");
        expect(error?.type === "error" && error.message).toContain("Failed to restore session");
        expect(events.at(-1)).toEqual({ type: "completed", status: "failed" });
        expect(await launches()).toHaveLength(1);
        expect(reports).toEqual([]);
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "an unchanged session id is reported once, not on every completed turn",
  async () => {
    await withSession(
      { sessionId: EXISTING, existingSessions: [EXISTING] },
      async ({ session, reports }) => {
        await runTurn(session, "one");
        await runTurn(session, "two");
        await runTurn(session, "three");
        expect(reports).toEqual([{ sessionId: EXISTING }]);
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "a turn that cannot be spawned rejects the input and leaves the session idle",
  async () => {
    await withSession({}, async ({ session, launches, workspace }) => {
      // Bun.spawn throws synchronously for a working directory that does not exist.
      await rm(workspace, { recursive: true });
      await expect(session.sendMessage("first")).rejects.toThrow("ENOENT");
      expect(await launches()).toEqual([]);

      // The failed spawn did not leave the session "running": the next input starts a turn, and
      // it still names its session with `--session-id`, because no turn ever created it.
      await mkdir(workspace);
      const events = await runTurn(session, "second");
      expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });
      const [launch, ...rest] = await launches();
      expect(rest).toEqual([]);
      expect(launch?.newSessionId).toBeDefined();
      expect(launch?.resumeId).toBeUndefined();
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
