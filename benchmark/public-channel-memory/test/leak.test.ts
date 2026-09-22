import { expect, test } from "bun:test";
import { classifyMechanism } from "../src/leak";

test("missing reply, offer, or citations are mechanism failures", () => {
  expect(classifyMechanism({ reply: null, offerMessageId: "o", citationCount: 1, toolsUsed: ["ov_find"] }).mechanism).toBe(
    "no_reply",
  );
  expect(classifyMechanism({ reply: "Seattle", offerMessageId: null, citationCount: 0, toolsUsed: [] }).mechanism).toBe(
    "no_offer",
  );
  expect(
    classifyMechanism({ reply: "Seattle", offerMessageId: "o", citationCount: 0, toolsUsed: ["ov_find"] }).mechanism,
  ).toBe("uncited_offer");
});

test("message_read-only recall is a leak and not headline-eligible", () => {
  const leaked = classifyMechanism({
    reply: "Seattle",
    offerMessageId: "o",
    citationCount: 2,
    toolsUsed: ["message_read"],
  });
  expect(leaked).toEqual({ mechanism: "leak", headlineEligible: false });
});

test("cited memory-tool recall is headline-eligible", () => {
  expect(
    classifyMechanism({
      reply: "Seattle",
      offerMessageId: "o",
      citationCount: 2,
      toolsUsed: ["ov_find", "ov_read"],
    }),
  ).toEqual({ mechanism: "ok", headlineEligible: true });
  expect(
    classifyMechanism({
      reply: "Seattle",
      offerMessageId: "o",
      citationCount: 1,
      toolsUsed: [],
    }).headlineEligible,
  ).toBe(true);
});

test("timeouts are not headline-eligible", () => {
  expect(
    classifyMechanism({
      reply: null,
      offerMessageId: null,
      citationCount: 0,
      toolsUsed: [],
      timedOut: true,
    }).mechanism,
  ).toBe("timeout");
});
