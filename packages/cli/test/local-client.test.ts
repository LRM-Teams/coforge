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

test("rejects legacy cf_proxy_ tokens without contacting the proxy", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));

  await expect(
    connectLocal("", `cf_proxy_${"a".repeat(43)}`, "http://proxy.test/agent/message").check(),
  ).rejects.toThrow("coforge agent context is invalid");
  expect(fetch).not.toHaveBeenCalled();
});
