import { expect, test } from "bun:test";
import {
  buildCritiqueCompareMessages,
  buildCritiqueSuccessMessages,
  buildMergeRulesMessages,
  buildOutcomeMessages,
  CRITIQUE_RULES_FULL_THRESHOLD,
} from "../src/server/group-memory/distillation-prompts.server";

/**
 * Golden prompt tests for the distillation pass (ADR 0053 slice 3): the
 * ported prompt shapes are locked by structure, not incidental whitespace —
 * outcome JSON verdict shape, numbered-rule referencing, the JSON operation
 * contract, the rules-full ADD suppression suffix, and the merge pass's
 * strict-inputs rule. If these break, the port drifted.
 */

test("outcome prompt demands the JSON verdict with reason and key steps", () => {
  const messages = buildOutcomeMessages({
    episodeTitle: "Ship the report",
    transcript: "alice: let's ship it\nbob: done",
  });
  expect(messages).toHaveLength(2);
  expect(messages[0].role).toBe("system");
  expect(messages[1].content).toContain("Ship the report");
  expect(messages[1].content).toContain("alice: let's ship it");
  const system = messages[0].content;
  expect(system).toContain('"outcome": "success" | "failure"');
  expect(system).toContain("reached its goal");
  expect(system).toContain("abandoned");
});

test("critique prompts number existing rules and pin the JSON operation contract", () => {
  const messages = buildCritiqueSuccessMessages({
    successCases: [{ title: "Deploy Friday", keySteps: "tag, build, ship" }],
    existingRules: [
      "Ship with migrations first, because state drifts otherwise",
      "Never hotfix, because audit breaks",
    ],
    rulesFull: false,
  });
  const user = messages[1].content;
  expect(user).toContain("## Here are the EXISTING RULES (numbered — reference them by index):");
  expect(user).toContain("1. Ship with migrations first, because state drifts otherwise");
  expect(user).toContain("2. Never hotfix, because audit breaks");
  expect(user).toContain('"operations": [');
  expect(user).toContain('{"op": "ADD", "statement": "..."}');
  expect(user).toContain("Do at most 4 operations");
  expect(user).toContain('"XXX, because XXX"');
  expect(messages[0].content).not.toContain("stop ADD rule");
});

test("critique prompts gain the reference method's ADD-suppression suffix when rules are full", () => {
  const full = buildCritiqueSuccessMessages({
    successCases: [{ title: "t", keySteps: "k" }],
    existingRules: [],
    rulesFull: true,
  });
  expect(full[0].content).toContain(
    "Focus on REMOVE or EDIT or AGREE rules first, and stop ADD rule unless the new rule is VERY insightful and different from EXISTING RULES.",
  );
  expect(CRITIQUE_RULES_FULL_THRESHOLD).toBe(10);
  const empty = buildCritiqueCompareMessages({
    successCase: { title: "s", keySteps: "k" },
    failureCase: { title: "f", reason: "r", keySteps: "k" },
    existingRules: [],
    rulesFull: false,
  });
  expect(empty[1].content).toContain("1. (none yet)");
  expect(empty[1].content).toContain("### Failed reason\nr");
});

test("merge prompt keeps the strict-inputs rule and the limit", () => {
  const messages = buildMergeRulesMessages({
    rules: ["rule one, because a", "rule two, because b"],
    limit: 1,
  });
  expect(messages[0].content).toContain("**must be based strictly on the given inputs**");
  expect(messages[1].content).toContain("no more than 1 refined insights");
  expect(messages[1].content).toContain("1. rule one, because a");
  expect(messages[0].content).toContain('"merged": [');
});
