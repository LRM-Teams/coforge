import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_OPERATION_KEY_PATTERN } from "@lrm/coforge-sdk/agent";
import { createSession } from "../src/runner";

/**
 * Memory Agent turn-level smoke (ADR 0053-G, manual gate): a REAL model runs
 * the fenced memory-explorer profile's own turn — the eight native tools, the
 * memory-first discipline, a stubbed local proxy — answering an explicit
 * team-memory question. This is the producer-side pin the layer tests cannot
 * give: given only the tool schemas, their descriptions, and the standing
 * discipline, does a live model autonomously reach memory_start, and does the
 * start_key it invents satisfy the server's operation-key contract?
 *
 * Live conviction (2026-09-21, recorded in ADR 0053's Validation): without
 * the pattern on the schema the live model sent "closing work items
 * explicitly" and burned 15 minutes on opaque 400s; with it, the same model
 * invented "closing-work-items" on its next run.
 *
 * Runs via `mise run test:e2e:memory-explorer-turn` with MEMORY_SMOKE_* env;
 * skips cleanly (zero tests, exit 0) without MEMORY_SMOKE_API_KEY. Run it
 * deliberately — it spends real tokens and one reasoning turn can take
 * minutes.
 *
 * The proxy is a stub: the agent tool layer only relays JSON, so plausible
 * payloads keep the turn grounded while the recorded calls carry the
 * assertion. The exploration/offer/message WIRE is pinned layer-by-layer by
 * the regression suites (SDK codec, daemon proxy, transport, web boundary);
 * this test pins the model's tool CHOICE, which only a real turn can.
 */

const API_KEY = Bun.env.MEMORY_SMOKE_API_KEY;
const BASE_URL =
  Bun.env.MEMORY_SMOKE_BASE_URL ??
  "https://modelfactory.lenovo.com/service-large-600-1777255649450/llm/v1";
const MODEL = Bun.env.MEMORY_SMOKE_MODEL ?? "DeepSeek-V4-Flash-0731";
const PROVIDER_ID = Bun.env.MEMORY_SMOKE_PROVIDER_ID ?? "lenovo-deepseek-v4-flash";

function skip(message: string): void {
  console.log(JSON.stringify({ event: "memory_explorer_turn.skipped", reason: message }));
}

const QUESTION =
  "What does the team say about closing work items explicitly? " +
  "Is there a recorded lesson about closing or completing tasks?";

/** Condensed mirror of the daemon's fenced standing section
 * (buildMemoryExplorerSection, ADR 0052-E). The live instructions are
 * daemon-side and recorded in ADR 0053; the mirror keeps the tool-facing
 * contract under test self-contained. */
const INSTRUCTIONS = `You are this Workspace's Memory Agent. Your eight native tools are your whole toolset:
memory_start, memory_explore, memory_redirect, memory_submit, memory_offer,
send_channel_message, message_check, and message_read. You have no shell.

- When anyone asks about team memory — lessons, rules, practices, what the team learned — START
  with memory_start (and memory_explore from the served citations), never with channel history
  alone; the distilled memory is the authority.
- memory_start's start_key is a short idempotency handle you invent — letters, digits, hyphens
  or underscores, never spaces (e.g. closing-work-items). It identifies the exploration run;
  it is not the question, and reusing it replays the same exploration.
- Answer from what the exploration served you. Every claim you make about team practice cites
  what you found; say plainly when memory holds nothing on the topic.`;

const SESSION_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const citations = [
  {
    citationId: "insight:2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
    kind: "insight",
    id: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
    snippet:
      "Close work items explicitly: move a task to in_review for human validation, then to done " +
      "after approval — silently leaving tasks open broke the weekly rollup twice.",
  },
  {
    citationId: "skill:3c4d5e6f-7a8b-4c9d-0e1f-2a3b4c5d6e7f",
    kind: "skill",
    id: "3c4d5e6f-7a8b-4c9d-0e1f-2a3b4c5d6e7f",
    snippet:
      "Before ending a collaboration session, verify and explicitly close every planned deliverable " +
      "so completion is never ambiguous.",
  },
];

if (!API_KEY) {
  skip("MEMORY_SMOKE_API_KEY is not set");
} else {
  const work = mkdtempSync("/tmp/memory-explorer-turn-");
  const workspace = join(work, "workspace");
  const agentDir = join(work, "agent");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  // The stub local proxy: records every tool call, answers with plausible
  // wire payloads. The fenced session resolves its provider from the agent
  // dir's models.json — the same seeding shape the dev daemon copies from
  // the user's models.json.
  const calls: Array<{
    path: string;
    op?: string;
    operation?: string;
    body: Record<string, unknown>;
  }> = [];
  const proxy = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      calls.push({
        path,
        op: body.op as string | undefined,
        operation: body.operation as string | undefined,
        body,
      });
      if (path === "/api/agent/v1/memory") {
        if (body.op === "close")
          return Response.json({
            ok: true,
            sessionId: SESSION_ID,
            state: "closed",
            found: true,
            summary: null,
            citations,
            duplicate: false,
          });
        if (body.op === "offer") return Response.json({ ok: true, published: true });
        // start | explore | redirect: keep the session active with served citations.
        return Response.json({
          ok: true,
          sessionId: SESSION_ID,
          state: "active",
          items: citations,
          remainingSteps: 2,
          duplicate: false,
        });
      }
      if (path === "/api/agent/v1/messages") {
        if (body.operation === "send")
          return Response.json({
            requestId: body.requestId,
            accepted: true,
            messageId: "4d5e6f7a-8b9c-4d0e-1f2a-3b4c5d6e7f8a",
            messages: [],
            summaries: [],
            state: "sent",
            decision: "forward",
            reason: "model_seen_boundary",
          });
        if (body.operation === "read")
          return Response.json({ requestId: body.requestId, messages: [] });
        return Response.json({
          requestId: body.requestId,
          accepted: true,
          attentionCount: 0,
          summaries: [],
          messages: [],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [PROVIDER_ID]: {
          api: "openai-completions",
          apiKey: API_KEY,
          baseUrl: BASE_URL,
          models: [
            {
              id: MODEL,
              name: "Memory explorer turn smoke model",
              contextWindow: 128000,
              input: ["text"],
              maxTokens: 8192,
            },
          ],
        },
      },
    }),
  );

  afterAll(() => {
    proxy.stop(true);
    rmSync(work, { recursive: true, force: true });
  });

  test("a live model reaches memory_start with a contract-valid start key", async () => {
    const created = await createSession({
      cwd: workspace,
      agentId: "memory-explorer-turn-smoke",
      agentDir,
      modelProvider: PROVIDER_ID,
      model: MODEL,
      apiKey: API_KEY,
      instructions: INSTRUCTIONS,
      environment: {
        // The proxy URL carries the messages base path — the fenced tools
        // replace the pathname wholesale (the connectLocal convention).
        COFORGE_AGENT_PROXY_URL: `http://127.0.0.1:${proxy.port}/api/agent/v1/messages`,
        COFORGE_AGENT_CONTEXT: `sfp_${"a".repeat(43)}`,
      },
      toolProfile: { kind: "memory-explorer" },
    });
    try {
      await created.session.prompt(QUESTION);
    } finally {
      await created.dispose();
    }

    const sequence = calls.map(
      (call) => `${call.path.replace("/api/agent/v1/", "")}:${call.op ?? call.operation}`,
    );
    console.log(JSON.stringify({ event: "memory_explorer_turn.tool_sequence", sequence }));

    // The fence holds: every call hit a known native route.
    expect(
      calls.every((call) => ["/api/agent/v1/memory", "/api/agent/v1/messages"].includes(call.path)),
    ).toBe(true);

    // The producer-side pin: an explicit memory question makes a live model
    // reach memory_start, and every start key it invents satisfies the
    // server's operation-key contract (the live 502 loop's root cause).
    const starts = calls.filter(
      (call) => call.path === "/api/agent/v1/memory" && call.op === "start",
    );
    expect(starts.length).toBeGreaterThan(0);
    for (const start of starts) {
      console.log(
        JSON.stringify({ event: "memory_explorer_turn.start_key", startKey: start.body.startKey }),
      );
      expect(String(start.body.startKey)).toMatch(new RegExp(`^${MEMORY_OPERATION_KEY_PATTERN}$`));
    }
    // One verified run of this smoke took 18.5 minutes (five reasoning turns
    // over start/explore/redirect/close); 30 minutes leaves honest headroom
    // without inviting a hung-run hang.
  }, 1_800_000);
}
