import { expect, test } from "bun:test";

import {
  agentMessageSender,
  UnresolvedMessageSenderError,
} from "#src/server/conversations/sender-display.server";

test("a null sender is the system identity: kind system, no handle, no description", () => {
  expect(agentMessageSender(null)).toEqual({ kind: "system", handle: "", description: "" });
  expect(agentMessageSender(undefined)).toEqual({ kind: "system", handle: "", description: "" });
});

test("an Agent-authored sender renders kind agent with its handle and description", () => {
  const sender = agentMessageSender({
    agentId: "agent-1",
    agent: { name: "scout", description: "release bot" },
    user: null,
  });
  expect(sender).toEqual({ kind: "agent", handle: "scout", description: "release bot" });
});

test("an Agent sender with no description renders an empty description", () => {
  const sender = agentMessageSender({
    agentId: "agent-1",
    agent: { name: "scout", description: "" },
    user: null,
  });
  expect(sender).toEqual({ kind: "agent", handle: "scout", description: "" });
});

test("a human-authored sender renders kind human with its username and description", () => {
  const sender = agentMessageSender({
    agentId: null,
    agent: null,
    user: { username: "ada", description: "engineering lead" },
  });
  expect(sender).toEqual({ kind: "human", handle: "ada", description: "engineering lead" });
});

test("an Agent sender with no resolvable name throws a named error rather than substituting one", () => {
  expect(() => agentMessageSender({ agentId: "agent-1", agent: null, user: null })).toThrow(
    UnresolvedMessageSenderError,
  );
  expect(() => agentMessageSender({ agentId: "agent-1", agent: null, user: null })).toThrow(
    "Agent message sender could not be resolved",
  );
});

test("a human sender with no resolvable username throws a named error rather than a bare @", () => {
  expect(() => agentMessageSender({ agentId: null, agent: null, user: null })).toThrow(
    UnresolvedMessageSenderError,
  );
});

test("a stored name that is not a public handle is refused, not passed on to an Agent", () => {
  expect(() =>
    agentMessageSender({
      agentId: null,
      agent: null,
      user: { username: "Ada Lovelace", description: "" },
    }),
  ).toThrow("public @username");
});

test("an internal id standing in for a name is refused", () => {
  expect(() =>
    agentMessageSender({
      agentId: "agent-1",
      agent: { name: "2c9d2c18-2a0b-4a95-9e5a-111111111111", description: "" },
      user: null,
    }),
  ).toThrow(UnresolvedMessageSenderError);
});
