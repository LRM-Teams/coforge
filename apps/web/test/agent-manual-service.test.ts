import { expect, test } from "bun:test";
import {
  recordManualEvent,
  resolveManualGet,
  resolveManualSearch,
} from "../src/server/agents/agent-manual.service";

const VALID_INTENT = "Open a pull request for a bound repository";
const VALID_REASON = "Confirm the exact clone and push commands to use";

test("resolveManualGet returns the generated index for the index topic", () => {
  const outcome = resolveManualGet({ topic: "index", intent: VALID_INTENT, reason: VALID_REASON });
  expect(outcome.status).toBe(200);
  if (outcome.status !== 200) throw new Error("expected a hit");
  expect(outcome.body.ok).toBe(true);
  expect(outcome.body.docId).toBe("index");
  expect(outcome.body.content.endsWith("\n")).toBe(true);
  expect(outcome.recordOutcome).toBe("hit");
});

test("resolveManualGet returns a known topic's content, ending in a newline", () => {
  const outcome = resolveManualGet({ topic: "github", intent: VALID_INTENT, reason: VALID_REASON });
  expect(outcome.status).toBe(200);
  if (outcome.status !== 200) throw new Error("expected a hit");
  expect(outcome.body.docId).toBe("github");
  expect(outcome.body.topicOrPath).toBe("github");
  expect(outcome.body.docState).toBe("published");
  expect(outcome.body.contentType).toBe("text/markdown");
  expect(outcome.body.content.endsWith("\n")).toBe(true);
  expect(outcome.resultSlugs).toEqual(["github"]);
});

test("resolveManualGet 404s an unknown but well-formed topic slug", () => {
  const outcome = resolveManualGet({
    topic: "does-not-exist",
    intent: VALID_INTENT,
    reason: VALID_REASON,
  });
  expect(outcome.status).toBe(404);
  if (outcome.status !== 404) throw new Error("expected not_found");
  expect(outcome.body.errorCode).toBe("knowledge_not_found");
  expect(outcome.recordOutcome).toBe("not_found");
});

test("resolveManualGet 400s a malformed topic slug before checking intent/reason", () => {
  const outcome = resolveManualGet({ topic: "Not Valid!", intent: "", reason: "" });
  expect(outcome.status).toBe(400);
  if (outcome.status !== 400) throw new Error("expected invalid");
  expect(outcome.body.errorCode).toBe("knowledge_topic_invalid");
});

test("resolveManualGet 400s with one error naming both fields when intent and reason are both invalid", () => {
  const outcome = resolveManualGet({ topic: "github", intent: "short", reason: "short" });
  expect(outcome.status).toBe(400);
  if (outcome.status !== 400) throw new Error("expected invalid");
  expect(outcome.body.errorCode).toBe("knowledge_intent_invalid");
  expect(outcome.body.error).toContain("--intent");
  expect(outcome.body.error).toContain("--reason");
});

test("resolveManualGet 400s reason alone when only reason is invalid", () => {
  const outcome = resolveManualGet({ topic: "github", intent: VALID_INTENT, reason: "short" });
  expect(outcome.status).toBe(400);
  if (outcome.status !== 400) throw new Error("expected invalid");
  expect(outcome.body.errorCode).toBe("knowledge_reason_invalid");
});

test("resolveManualSearch returns ranked hits and a 404 for no matches", () => {
  const hit = resolveManualSearch({
    query: "GitHub pull request",
    intent: VALID_INTENT,
    reason: VALID_REASON,
  });
  expect(hit.status).toBe(200);
  if (hit.status !== 200) throw new Error("expected a hit");
  expect(hit.body.ok).toBe(true);
  expect(hit.body.query).toBe("GitHub pull request");
  expect(hit.body.scope).toBeNull();
  expect(hit.body.results.length).toBeGreaterThan(0);
  expect(hit.resultSlugs).toEqual(hit.body.results.map((r) => r.slug));

  const miss = resolveManualSearch({
    query: "nonexistentterm",
    intent: VALID_INTENT,
    reason: VALID_REASON,
  });
  expect(miss.status).toBe(404);
  if (miss.status !== 404) throw new Error("expected not_found");
  expect(miss.body.errorCode).toBe("knowledge_not_found");
});

test("resolveManualSearch 400s an empty query before checking intent/reason", () => {
  const outcome = resolveManualSearch({ query: "", intent: "", reason: "" });
  expect(outcome.status).toBe(400);
  if (outcome.status !== 400) throw new Error("expected invalid");
  expect(outcome.body.errorCode).toBe("knowledge_query_invalid");
});

test("recordManualEvent is a no-op without a repository and never throws on a logging failure", async () => {
  await recordManualEvent(
    undefined,
    { workspaceId: "w", agentId: "a" },
    {
      kind: "get",
      topicOrQuery: "github",
      intent: VALID_INTENT,
      reason: VALID_REASON,
      outcome: "hit",
      resultSlugs: ["github"],
    },
  );

  let loggedError: unknown;
  await recordManualEvent(
    {
      record: async () => {
        throw new Error("db unavailable");
      },
    },
    { workspaceId: "w", agentId: "a" },
    {
      kind: "search",
      topicOrQuery: "x",
      intent: VALID_INTENT,
      reason: VALID_REASON,
      outcome: "not_found",
      resultSlugs: [],
    },
    (error) => {
      loggedError = error;
    },
  );
  expect(loggedError).toBeInstanceOf(Error);
});

test("recordManualEvent forwards the event to the repository on success", async () => {
  let recorded: unknown;
  await recordManualEvent(
    {
      record: async (event) => {
        recorded = event;
      },
    },
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      kind: "get",
      topicOrQuery: "github",
      intent: VALID_INTENT,
      reason: VALID_REASON,
      outcome: "hit",
      resultSlugs: ["github"],
    },
  );
  expect(recorded).toEqual({
    workspaceId: "workspace-1",
    agentId: "agent-1",
    kind: "get",
    topicOrQuery: "github",
    intent: VALID_INTENT,
    reason: VALID_REASON,
    outcome: "hit",
    resultSlugs: ["github"],
  });
});
