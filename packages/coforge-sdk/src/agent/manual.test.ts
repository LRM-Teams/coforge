import { expect, test } from "bun:test";
import {
  decodeAgentManualErrorResponse,
  decodeAgentManualGetResponse,
  decodeAgentManualSearchResponse,
  type AgentManualGetResponse,
  type AgentManualSearchResponse,
} from "./manual";

test("decodeAgentManualGetResponse accepts a well-formed response", () => {
  const value: AgentManualGetResponse = {
    ok: true,
    docId: "github",
    topicOrPath: "github",
    docVersion: "abc123",
    docState: "published",
    contentType: "text/markdown",
    content: "# GitHub\n",
  };
  expect(decodeAgentManualGetResponse(value)).toEqual(value);
});

test("decodeAgentManualGetResponse rejects a missing or wrong-typed field", () => {
  const valid = {
    ok: true,
    docId: "github",
    topicOrPath: "github",
    docVersion: "abc123",
    docState: "published",
    contentType: "text/markdown",
    content: "# GitHub\n",
  };
  for (const field of Object.keys(valid))
    expect(() => decodeAgentManualGetResponse({ ...valid, [field]: undefined })).toThrow();
  expect(() => decodeAgentManualGetResponse({ ...valid, docState: "draft" })).toThrow();
  expect(() => decodeAgentManualGetResponse({ ...valid, contentType: "text/plain" })).toThrow();
  expect(() => decodeAgentManualGetResponse(null)).toThrow();
});

test("decodeAgentManualSearchResponse accepts a well-formed response", () => {
  const value: AgentManualSearchResponse = {
    ok: true,
    query: "github",
    scope: null,
    results: [{ slug: "github", title: "GitHub", firstScreen: "Clone a repo." }],
  };
  expect(decodeAgentManualSearchResponse(value)).toEqual(value);
});

test("decodeAgentManualSearchResponse rejects a non-null scope or a malformed result", () => {
  expect(() =>
    decodeAgentManualSearchResponse({ ok: true, query: "x", scope: "recipes", results: [] }),
  ).toThrow();
  expect(() =>
    decodeAgentManualSearchResponse({
      ok: true,
      query: "x",
      scope: null,
      results: [{ slug: "github", title: "GitHub" }],
    }),
  ).toThrow();
});

test("decodeAgentManualErrorResponse accepts every declared error code and rejects others", () => {
  const codes = [
    "knowledge_not_found",
    "knowledge_topic_invalid",
    "knowledge_query_invalid",
    "knowledge_intent_invalid",
    "knowledge_reason_invalid",
  ] as const;
  for (const errorCode of codes)
    expect(decodeAgentManualErrorResponse({ ok: false, errorCode, error: "x" })).toEqual({
      ok: false,
      errorCode,
      error: "x",
    });
  expect(
    decodeAgentManualErrorResponse({ ok: false, errorCode: "bogus", error: "x" }),
  ).toBeUndefined();
  expect(decodeAgentManualErrorResponse({ ok: true })).toBeUndefined();
});
