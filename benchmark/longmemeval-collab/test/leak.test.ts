import { classifyMechanism } from "../src/leak";

describe("classifyMechanism", () => {
  const ok = {
    reply: "Business Administration.",
    offerMessageId: "offer-1",
    citationCount: 2,
    memoryLeakMessageIds: [],
  };

  test("cited offer plus grounded reply is headline eligible", () => {
    expect(classifyMechanism(ok)).toEqual({ mechanism: "ok", headlineEligible: true });
  });

  test("timeout dominates", () => {
    expect(classifyMechanism({ ...ok, timedOut: true }).mechanism).toBe("timeout");
  });

  test("memory agent channel answer beside the offer is a leak", () => {
    const result = classifyMechanism({ ...ok, memoryLeakMessageIds: ["m-1"] });
    expect(result).toEqual({ mechanism: "leak", headlineEligible: false });
  });

  test("task reply without an offer is an ungrounded answer", () => {
    const result = classifyMechanism({ ...ok, offerMessageId: null });
    expect(result).toEqual({ mechanism: "no_offer", headlineEligible: false });
  });

  test("offer without citations cannot ground the reply", () => {
    const result = classifyMechanism({ ...ok, citationCount: 0 });
    expect(result).toEqual({ mechanism: "uncited_offer", headlineEligible: false });
  });

  test("missing task reply", () => {
    const result = classifyMechanism({ ...ok, reply: null });
    expect(result).toEqual({ mechanism: "no_reply", headlineEligible: false });
  });
});
