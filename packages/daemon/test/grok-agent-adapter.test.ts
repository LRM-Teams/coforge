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
/** Keeps the fake grok's turn open long enough for the test to queue input behind it. */
const turnDelay = { COFORGE_GROK_TURN_DELAY_MS: "150" };

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
    /** How many identity reports reject before one is accepted. */
    rejectedReports?: number;
  },
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "grok-adapter-"));
  const workspace = join(root, "workspace");
  const sessions = join(root, "sessions");
  const log = join(root, "launches.jsonl");
  const reports: SessionReport[] = [];
  let rejectedReports = options.rejectedReports ?? 0;
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
        if (rejectedReports > 0) {
          rejectedReports -= 1;
          throw new Error("identity report rejected");
        }
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
    await withSession({}, async ({ session, launches, reports }) => {
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
      // Two completed turns, one report: the id is reported when it is first known to resume.
      expect(reports).toEqual([{ sessionId: identity!.sessionId }]);
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
  "interrupt() ends the running turn as interrupted when grok dies by the signal, with no error",
  async () => {
    await withSession({ environment: { COFORGE_GROK_MODE: "hang" } }, async ({ session }) => {
      const events = record(session);
      const working = firstText(session);
      const completed = nthCompleted(session, 1);
      await session.sendMessage("hi");
      await working;
      // Grok 1.0.41 dies at once by SIGINT: no `error` frame, no `end`, nothing on stderr. The
      // turn's exit reports the requested stop as interrupted, not as a failure.
      await session.interrupt!();
      await completed;
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(events.at(-1)).toEqual({ type: "completed", status: "interrupted" });
    });
  },
  SESSION_BUDGET_MS,
);

test(
  "tool calls map to tool-start, tool-output and tool-end as grok reports them",
  async () => {
    await withSession(
      { environment: { COFORGE_GROK_MODE: "tools" } },
      async ({ session, workspace }) => {
        const events = await runTurn(session, "use tools");
        const failing = "echo probe-ok ; ls /definitely-missing-dir";
        const missing = join(workspace, "missing.txt");
        // The name is grok's own tool name; the daemon core decides what Activity a call is. The
        // shell's `rawInput` passes through, and a file read's `target_file` is carried as the
        // `file_path` that core reads. The text is the terminal update's `content`, never its
        // `rawOutput` (an object) or the first update's `content` (the command's description).
        expect(events.filter((event) => event.type.startsWith("tool-"))).toEqual([
          {
            type: "tool-start",
            id: "call-fixture-0",
            name: "read_file",
            input: { file_path: join(workspace, "present.txt") },
          },
          { type: "tool-output", id: "call-fixture-0", text: "1\u2192hello\n" },
          { type: "tool-end", id: "call-fixture-0", isError: false },
          {
            type: "tool-start",
            id: "call-fixture-1",
            name: "run_terminal_command",
            input: { command: failing, description: "Echo probe-ok then list missing dir" },
          },
          {
            type: "tool-output",
            id: "call-fixture-1",
            text: "probe-ok\nls: /definitely-missing-dir: No such file or directory\n",
          },
          // The command exited 1 but the call still ended `completed`: that is an error.
          { type: "tool-end", id: "call-fixture-1", isError: true },
          {
            type: "tool-start",
            id: "call-fixture-2",
            name: "read_file",
            input: { file_path: missing },
          },
          {
            type: "tool-output",
            id: "call-fixture-2",
            text: `Error: ${missing} does not exist.\nNote: your current working directory is ${workspace}`,
          },
          { type: "tool-end", id: "call-fixture-2", isError: true },
          {
            type: "tool-start",
            id: "call-fixture-3",
            name: "run_terminal_command",
            input: { command: "echo hi", description: "Say hi" },
          },
          { type: "tool-output", id: "call-fixture-3", text: "hi\n" },
          { type: "tool-end", id: "call-fixture-3", isError: false },
          {
            type: "tool-start",
            id: "call-fixture-4",
            name: "run_terminal_command",
            input: { command: "sleep 999", description: "Wait" },
          },
          { type: "tool-output", id: "call-fixture-4", text: "partial\n" },
          { type: "tool-end", id: "call-fixture-4", isError: true },
        ]);
        // Nothing of the shell's own bookkeeping (`output_file`, `current_dir`) is forwarded.
        expect(JSON.stringify(events)).not.toContain("terminal/call.log");
        expect(events.filter((event) => event.type === "text-delta")).toEqual([
          { type: "text-delta", text: "done" },
        ]);
        expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });
      },
    );
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
    // grok prints "not found locally" whenever the local copy is missing, before it asks the
    // remote; only a 404 from the remote means the session is gone. A remote that is down must
    // not cost the Agent a session that still exists.
    await withSession(
      {
        sessionId: EXISTING,
        existingSessions: [EXISTING],
        environment: {
          COFORGE_GROK_MODE: "crash",
          COFORGE_GROK_CRASH_STDERR: [
            `Session "${EXISTING}" not found locally, restoring conversation from remote...`,
            "Error: Failed to restore session from remote: fetching session record: session get failed: 503 Service Unavailable",
          ].join("\n"),
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
  "a rejected identity report is retried on the next completed turn",
  async () => {
    await withSession({ rejectedReports: 1 }, async ({ session, reports }) => {
      // The report settles after the turn's `completed`, so its error is collected session-wide.
      const errors: string[] = [];
      session.subscribe((event) => {
        if (event.type === "error") errors.push(event.message);
      });
      await runTurn(session, "one");
      expect(reports).toEqual([]);
      await runTurn(session, "two");
      expect(errors).toEqual(["identity report rejected"]);
      const identity = await session.readSessionIdentity!();
      expect(reports).toEqual([{ sessionId: identity!.sessionId }]);
      await runTurn(session, "three");
      expect(reports).toHaveLength(1);
    });
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

test(
  "input queued while a turn runs is joined into the next turn's prompt",
  async () => {
    await withSession(
      { sessionId: EXISTING, existingSessions: [EXISTING], environment: turnDelay },
      async ({ session, launches }) => {
        const both = nthCompleted(session, 2);
        // The first turn counts as running from the moment it is spawned, so the next two queue.
        await session.sendMessage("first");
        await Promise.all([session.sendMessage("second"), session.notify!("third")]);
        await both;
        const [first, second, ...rest] = await launches();
        expect(rest).toEqual([]);
        expect(first?.prompt).toBe("first");
        expect(second).toMatchObject({ prompt: "second\n\nthird", resumeId: EXISTING });
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "input queued behind a lost resume runs as its own turn once the replacement session has answered",
  async () => {
    const stale = "0195d5a0-4b2e-7c11-9a53-3f2f6b1d7e14";
    await withSession(
      { sessionId: stale, environment: turnDelay },
      async ({ session, launches, reports }) => {
        const bothTurns = nthCompleted(session, 2);
        await session.sendMessage("first");
        await session.sendMessage("second");
        await bothTurns;
        const [attempt, retry, queued, ...rest] = await launches();
        expect(rest).toEqual([]);
        expect(attempt).toMatchObject({ prompt: "first", resumeId: stale });
        expect(retry).toMatchObject({ prompt: "first" });
        expect(retry?.newSessionId).toBeDefined();
        expect(queued).toMatchObject({ prompt: "second", resumeId: retry?.newSessionId });
        expect(reports).toEqual([{ sessionId: retry!.newSessionId!, replacedSessionId: stale }]);
      },
    );
  },
  SESSION_BUDGET_MS,
);

test(
  "dispose kills a running turn and rejects queued input",
  async () => {
    await withSession({ environment: { COFORGE_GROK_MODE: "hang" } }, async ({ session }) => {
      let exited = false;
      session.onExit(() => {
        exited = true;
      });
      const working = firstText(session);
      await session.sendMessage("go");
      await working;
      const queued = session.notify!("queued while disposing");
      // Mark the rejection handled at once, so it never surfaces as unhandled before the assertion.
      queued.catch(() => undefined);
      await session.dispose();
      expect(exited).toBe(true);
      await expect(queued).rejects.toThrow("code agent session was disposed");
      await expect(session.sendMessage("after dispose")).rejects.toThrow(
        "code agent session is disposed",
      );
    });
  },
  SESSION_BUDGET_MS,
);

test(
  "a first turn that fails leaves the session identity unknown and reports nothing",
  async () => {
    await withSession(
      { environment: { COFORGE_GROK_MODE: "error", COFORGE_GROK_ERROR: "boom" } },
      async ({ session, reports }) => {
        const events = await runTurn(session, "go");
        expect(events.at(-1)).toEqual({ type: "completed", status: "failed" });
        expect(await session.readSessionIdentity!()).toMatchObject({ state: "unknown" });
        expect(reports).toEqual([]);
      },
    );
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
