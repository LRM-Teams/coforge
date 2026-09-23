import { expect, test } from "bun:test";
import { handleAgentManualGet } from "#src/routes/api/agent/v1/manual";
import { handleAgentManualSearchGet } from "#src/routes/api/agent/v1/manual_.search";

const VALID_INTENT = "Open a pull request for a bound repository";
const VALID_REASON = "Confirm the exact clone and push commands to use";

const getRequest = (search: string) =>
  new Request(`https://server.example/api/agent/v1/manual${search}`);
const searchRequest = (search: string) =>
  new Request(`https://server.example/api/agent/v1/manual/search${search}`);

test("GET /manual returns a topic and records a hit event", async () => {
  const events: unknown[] = [];
  const result = await handleAgentManualGet(
    getRequest(
      `?topic=github&intent=${encodeURIComponent(VALID_INTENT)}&reason=${encodeURIComponent(VALID_REASON)}`,
    ),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    { record: async (event) => void events.push(event) },
  );
  expect(result.status).toBe(200);
  const body = await result.json();
  expect(body.ok).toBe(true);
  expect(body.docId).toBe("github");
  expect(events).toEqual([
    {
      workspaceId: "workspace-1",
      agentId: "agent-1",
      kind: "get",
      topicOrQuery: "github",
      intent: VALID_INTENT,
      reason: VALID_REASON,
      outcome: "hit",
      resultSlugs: ["github"],
    },
  ]);
});

test("GET /manual records a not_found event and 404s an unknown topic", async () => {
  const events: unknown[] = [];
  const result = await handleAgentManualGet(
    getRequest(
      `?topic=does-not-exist&intent=${encodeURIComponent(VALID_INTENT)}&reason=${encodeURIComponent(VALID_REASON)}`,
    ),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    { record: async (event) => void events.push(event) },
  );
  expect(result.status).toBe(404);
  expect((await result.json()).errorCode).toBe("knowledge_not_found");
  expect(events).toHaveLength(1);
  expect((events[0] as { outcome: string }).outcome).toBe("not_found");
});

test("GET /manual never records an invalid-input 400", async () => {
  const events: unknown[] = [];
  const result = await handleAgentManualGet(
    getRequest("?topic=Not Valid&intent=x&reason=y"),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    { record: async (event) => void events.push(event) },
  );
  expect(result.status).toBe(400);
  expect((await result.json()).errorCode).toBe("knowledge_topic_invalid");
  expect(events).toHaveLength(0);
});

test("GET /manual still answers correctly when the event repository is unavailable", async () => {
  const result = await handleAgentManualGet(
    getRequest(
      `?topic=github&intent=${encodeURIComponent(VALID_INTENT)}&reason=${encodeURIComponent(VALID_REASON)}`,
    ),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    undefined,
  );
  expect(result.status).toBe(200);
});

test("GET /manual/search returns ranked results and records the matched slugs", async () => {
  const events: unknown[] = [];
  const result = await handleAgentManualSearchGet(
    searchRequest(
      `?query=${encodeURIComponent("GitHub pull request")}&intent=${encodeURIComponent(VALID_INTENT)}&reason=${encodeURIComponent(VALID_REASON)}`,
    ),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    { record: async (event) => void events.push(event) },
  );
  expect(result.status).toBe(200);
  const body = await result.json();
  expect(body.ok).toBe(true);
  expect(body.scope).toBeNull();
  expect(body.results.length).toBeGreaterThan(0);
  expect((events[0] as { resultSlugs: string[] }).resultSlugs).toEqual(
    body.results.map((r: { slug: string }) => r.slug),
  );
});

test("GET /manual/search 404s when nothing matches", async () => {
  const result = await handleAgentManualSearchGet(
    searchRequest(
      `?query=nonexistentterm&intent=${encodeURIComponent(VALID_INTENT)}&reason=${encodeURIComponent(VALID_REASON)}`,
    ),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    undefined,
  );
  expect(result.status).toBe(404);
  expect((await result.json()).errorCode).toBe("knowledge_not_found");
});

test("Manual get and search work without justification and still record scoped audit events", async () => {
  const events: unknown[] = [];
  const principal = { workspaceId: "workspace-1", agentId: "agent-1" };
  const repository = { record: async (event: unknown) => void events.push(event) };
  expect(
    (await handleAgentManualGet(getRequest("?topic=tasks"), principal, repository)).status,
  ).toBe(200);
  expect(
    (await handleAgentManualSearchGet(searchRequest("?query=attachments"), principal, repository))
      .status,
  ).toBe(200);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ ...principal, intent: "", reason: "", outcome: "hit" });
});
