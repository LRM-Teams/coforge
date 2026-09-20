import { describe, expect, test } from "bun:test";
import {
  assertValidMessageSender,
  isValidMessageSender,
  renderMessageSender,
} from "./message-sender";

describe("message sender rendering", () => {
  test("renders a handle, and a description after an em dash", () => {
    expect(renderMessageSender("human", "alice")).toBe("@alice");
    expect(renderMessageSender("agent", "scout", "release bot")).toBe("@scout — release bot");
    expect(renderMessageSender("system", "")).toBe("system");
  });
});

describe("message sender validation", () => {
  test("accepts the closed kinds with a well-formed handle", () => {
    expect(isValidMessageSender("human", "alice")).toBe(true);
    expect(isValidMessageSender("agent", "scout")).toBe(true);
    expect(isValidMessageSender("system", "")).toBe(true);
  });

  test("accepts an Agent name at the full length its own schema allows", () => {
    expect(isValidMessageSender("agent", "a".repeat(60))).toBe(true);
    expect(isValidMessageSender("agent", "a".repeat(61))).toBe(false);
  });

  test("accepts a username's underscore and an Agent name's hyphen", () => {
    expect(isValidMessageSender("human", "ada_lovelace")).toBe(true);
    expect(isValidMessageSender("agent", "release-bot")).toBe(true);
  });

  test("rejects an unknown kind, a missing handle, and a handle on a system sender", () => {
    expect(isValidMessageSender("third_party_app", "app")).toBe(false);
    expect(isValidMessageSender("human", "")).toBe(false);
    expect(isValidMessageSender("system", "alice")).toBe(false);
  });

  test("rejects a handle the identity schemas cannot produce", () => {
    expect(isValidMessageSender("human", "Alice")).toBe(false);
    expect(isValidMessageSender("agent", "-scout")).toBe(false);
    expect(isValidMessageSender("agent", "sc out")).toBe(false);
  });

  test("a rejected pair names the boundary that refused it", () => {
    expect(() => assertValidMessageSender("human", "", "Agent message record")).toThrow(
      "invalid Agent message record sender",
    );
    expect(() => assertValidMessageSender("agent", "scout", "Agent message record")).not.toThrow();
  });
});

describe("message sender identity exposure", () => {
  test("rejects a raw actor id offered as a handle", () => {
    expect(isValidMessageSender("human", "2c9d2c18-2a0b-4a95-9e5a-111111111111")).toBe(false);
    expect(isValidMessageSender("agent", "2C9D2C18-2A0B-4A95-9E5A-111111111111")).toBe(false);
  });

  test("still accepts an ordinary hyphenated Agent name", () => {
    expect(isValidMessageSender("agent", "release-bot-2c9d2c18")).toBe(true);
  });
});
