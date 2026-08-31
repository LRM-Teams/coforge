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
