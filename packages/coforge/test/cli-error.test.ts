import { expect, test } from "bun:test";
import {
  CliError,
  renderCliErrorJson,
  renderCliErrorText,
  unknownDeliveryNextAction,
  withOutputMode,
} from "../src/cli-error";

test("text rendering prints the fixed lines in order and omits undefined fields", () => {
  const error = new CliError({ code: "SEND_FAILED", message: "boom" });
  const rendered = renderCliErrorText(error);
  expect(rendered.split("\n")).toEqual(["Error: boom", "Code: SEND_FAILED", "Retryable: unknown"]);
});

test("text rendering includes every diagnostic field when present, in the specified order", () => {
  const error = new CliError({
    code: "SEND_FAILED",
    message: "boom",
    retryable: false,
    effect: "delivery_unknown",
    correlationId: "corr-1",
    proxy: {
      failureClass: "upstream_http_response",
      causeCode: "HTTP_500",
      routeFamily: "agent-api/send",
      upstreamLayer: "http_status",
      upstreamStatus: 500,
      responseStarted: true,
      responseComplete: true,
    },
    draftSaved: true,
    suggestedNextAction: "Wait, or ask a person.",
  });
  expect(renderCliErrorText(error).split("\n")).toEqual([
    "Error: boom",
    "Code: SEND_FAILED",
    "Retryable: no",
    "Effect: delivery_unknown",
    "Correlation: corr-1",
    "Proxy failure class: upstream_http_response",
    "Proxy cause code: HTTP_500",
    "Proxy route family: agent-api/send",
    "Proxy upstream layer: http_status",
    "Proxy upstream status: 500",
    "Proxy response started: yes",
    "Proxy response complete: yes",
    "Draft saved: yes",
    "Next action: Wait, or ask a person.",
  ]);
});

test("contextText is printed before the Error: line, separated by a blank line", () => {
  const error = new CliError({
    code: "SEND_HELD_AS_DRAFT",
    message: "Message held as draft; no target delivery occurred.",
    contextText: "Freshness hold: 1 newer message arrived.",
  });
  const rendered = renderCliErrorText(error);
  expect(rendered.startsWith("Freshness hold: 1 newer message arrived.\n\nError:")).toBe(true);
});

test("json rendering emits one object with snake_case proxy fields and an explicit null retryable", () => {
  const error = new CliError({ code: "INVALID_JSON_RESPONSE", message: "bad shape" });
  const parsed = JSON.parse(renderCliErrorJson(error));
  expect(parsed).toEqual({
    error: { message: "bad shape", code: "INVALID_JSON_RESPONSE", retryable: null },
  });
});

test("json rendering carries draft_saved, correlation_id, proxy and next_action when set", () => {
  const error = new CliError({
    code: "SEND_FAILED",
    message: "boom",
    retryable: false,
    draftSaved: true,
    correlationId: "corr-1",
    proxy: { failureClass: "mid_response_transport", upstreamStatus: 200 },
    suggestedNextAction: "Wait.",
  });
  const parsed = JSON.parse(renderCliErrorJson(error));
  expect(parsed.error.draft_saved).toBe(true);
  expect(parsed.error.correlation_id).toBe("corr-1");
  expect(parsed.error.proxy).toEqual({
    failure_class: "mid_response_transport",
    upstream_status: 200,
  });
  expect(parsed.error.next_action).toBe("Wait.");
});

test("withOutputMode returns a copy carrying every field but the requested output mode", () => {
  const error = new CliError({ code: "SEND_FAILED", message: "boom", draftSaved: true });
  const json = withOutputMode(error, "json");
  expect(json).not.toBe(error);
  expect(json.outputMode).toBe("json");
  expect(json.code).toBe("SEND_FAILED");
  expect(json.draftSaved).toBe(true);
  expect(error.outputMode).toBe("text");
});

test("the unknown-delivery next action tells the Agent not to resend and names the exact commands", () => {
  const text = unknownDeliveryNextAction("@ada");
  expect(text).toContain("Delivery state is UNKNOWN");
  expect(text).toContain("Do not resend on this evidence");
  expect(text).toContain('coforge message read --target "@ada"');
  expect(text).toContain('coforge message send --send-draft --target "@ada"');
});
