import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { connectLocal } from "../src/local-client";

afterEach(() => {
  mock.restore();
});

test("accepts sfp_ daemon-local Proxy tokens", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ requestId: "request", accepted: true, attentionCount: 0, messages: [] }),
  );

  await connectLocal("", `sfp_${"a".repeat(43)}`, "http://proxy.test/agent/message").check();

  expect(fetch).toHaveBeenCalledTimes(1);
});

test("shows actionable validation errors returned by the Agent proxy", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("ambiguous message prefix; use the full UUID", { status: 400 }),
  );

  await expect(
    connectLocal("", `sfp_${"a".repeat(43)}`, "http://proxy.test/agent/message").read("deadbeef"),
  ).rejects.toThrow("ambiguous message prefix; use the full UUID");
});

test("sanitizes unknown Agent proxy error bodies", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("upstream failure included a secret", { status: 400 }),
  );

  await expect(
    connectLocal("", `sfp_${"a".repeat(43)}`, "http://proxy.test/agent/message").check(),
  ).rejects.toThrow(/^agent proxy request failed \(400\)$/);
});

test("downloads attachments through the daemon-local proxy", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("attachment bytes", {
      headers: { "content-disposition": "attachment; filename=proof.txt" },
    }),
  );
  const result = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    "http://proxy.test/agent/message",
  ).view("attachment-1");
  expect(new TextDecoder().decode(result.bytes)).toBe("attachment bytes");
  expect(fetch).toHaveBeenCalledWith(
    "http://proxy.test/agent/attachment?attachmentId=attachment-1",
    expect.any(Object),
  );
});

test("rejects legacy cf_proxy_ tokens without contacting the proxy", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));

  await expect(
    connectLocal("", `cf_proxy_${"a".repeat(43)}`, "http://proxy.test/agent/message").check(),
  ).rejects.toThrow("coforge agent context is invalid");
  expect(fetch).not.toHaveBeenCalled();
});

test("posts validated reminders to the derived endpoint with implicit bearer context", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      protocolMajor: 1,
      requestId: "request",
      workspaceId: "workspace",
      computerId: "computer",
      agentId: "agent",
      accepted: true,
      reminders: [],
      events: [],
    }),
  );
  await connectLocal("", `sfp_${"a".repeat(43)}`, "http://proxy.test/agent/message").reminder({
    operation: "schedule",
    title: "Check release",
    target: "#general",
    messageId: "deadbeef",
    repeat: "daily@09:30",
    timezone: "Asia/Shanghai",
  });
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe("http://proxy.test/agent/reminder");
  expect(init?.headers).toEqual({
    authorization: `Bearer sfp_${"a".repeat(43)}`,
    "content-type": "application/json",
  });
  const body = JSON.parse(String(init?.body));
  expect(body).toMatchObject({
    operation: "schedule",
    title: "Check release",
    repeat: "daily@09:30",
    timezone: "Asia/Shanghai",
  });
  expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.context).toBeUndefined();
});
