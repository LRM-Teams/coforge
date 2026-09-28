import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { verifyGitHubWebhookSignature } from "#src/server/integrations/github-webhook.server";

const secret = "test-webhook-secret";
const body = JSON.stringify({ action: "created", installation: { id: 1 } });

function sign(value: string, withSecret = secret) {
  return `sha256=${createHmac("sha256", withSecret).update(value, "utf8").digest("hex")}`;
}

describe("verifyGitHubWebhookSignature", () => {
  test("accepts a signature computed with the same secret over the same raw body", () => {
    expect(verifyGitHubWebhookSignature(secret, body, sign(body))).toBe(true);
  });

  test("rejects a missing header", () => {
    expect(verifyGitHubWebhookSignature(secret, body, null)).toBe(false);
  });

  test("rejects a header without the sha256= prefix", () => {
    const raw = createHmac("sha256", secret).update(body, "utf8").digest("hex");
    expect(verifyGitHubWebhookSignature(secret, body, raw)).toBe(false);
  });

  test("rejects a signature computed with a different secret", () => {
    expect(verifyGitHubWebhookSignature(secret, body, sign(body, "wrong-secret"))).toBe(false);
  });

  test("rejects a signature for a different body (raw-body tampering)", () => {
    expect(verifyGitHubWebhookSignature(secret, body, sign(`${body}x`))).toBe(false);
  });

  test("rejects a signature of a different length instead of throwing", () => {
    expect(verifyGitHubWebhookSignature(secret, body, "sha256=deadbeef")).toBe(false);
  });
});
