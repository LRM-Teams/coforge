import { expect, test } from "bun:test";
import { handleAgentChannelMutePost } from "../src/routes/api/agent/v1/channels_.$channel.mute";
import { handleAgentChannelUnmutePost } from "../src/routes/api/agent/v1/channels_.$channel.unmute";
import { handleAgentThreadUnfollowPost } from "../src/routes/api/agent/v1/threads_.$thread.unfollow";
import { AgentMessageValidationError } from "../src/server/conversations/agent-message-validation-error.server";

const principal = { workspaceId: "workspace-1", agentId: "agent-1" };
const post = (path: string, body?: unknown) =>
  new Request(`https://server.example${path}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("mute forwards the decoded channel target and returns the accepted envelope", async () => {
  const calls: unknown[] = [];
  const result = await handleAgentChannelMutePost(
    post("/api/agent/v1/channels/%23general/mute", { requestId: "r-1" }),
    "#general",
    true,
    principal,
    {
      setAgentChannelMuted: async (...args) => {
        calls.push(args);
      },
      setAgentThreadFollowed: async () => {},
    },
  );
  expect(calls).toEqual([["workspace-1", "agent-1", "#general", true]]);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({
    protocolMajor: 1,
    requestId: "r-1",
    target: "#general",
    muted: true,
  });
});

test("mute generates a request id from an empty body", async () => {
  const result = await handleAgentChannelMutePost(
    post("/api/agent/v1/channels/%23general/mute"),
    "#general",
    true,
    principal,
    { setAgentChannelMuted: async () => {}, setAgentThreadFollowed: async () => {} },
  );
  const body = await result.json();
  expect(typeof body.requestId).toBe("string");
  expect(body.requestId.length).toBeGreaterThan(0);
});

test("mute returns the exact validation text as a plain-text 400 body", async () => {
  const result = await handleAgentChannelMutePost(
    post("/api/agent/v1/channels/%40ada/mute"),
    "@ada",
    true,
    principal,
    { setAgentChannelMuted: async () => {}, setAgentThreadFollowed: async () => {} },
  );
  expect(result.status).toBe(400);
  expect(await result.text()).toBe("mute requires a channel target");
});

test("mute hides an unexpected repository failure behind a generic message", async () => {
  const result = await handleAgentChannelMutePost(
    post("/api/agent/v1/channels/%23general/mute"),
    "#general",
    true,
    principal,
    {
      setAgentChannelMuted: async () => {
        throw new Error("database password leaked");
      },
      setAgentThreadFollowed: async () => {},
    },
  );
  expect(result.status).toBe(400);
  expect(await result.text()).toBe("channel mute failed");
});

test("mute surfaces an AgentMessageValidationError verbatim", async () => {
  const result = await handleAgentChannelMutePost(
    post("/api/agent/v1/channels/%23general/mute"),
    "#general",
    true,
    principal,
    {
      setAgentChannelMuted: async () => {
        throw new AgentMessageValidationError("message not found or not visible to this Agent");
      },
      setAgentThreadFollowed: async () => {},
    },
  );
  expect(result.status).toBe(400);
  expect(await result.text()).toBe("message not found or not visible to this Agent");
});

test("unmute forwards muted=false for the decoded channel target", async () => {
  const calls: unknown[] = [];
  const result = await handleAgentChannelUnmutePost(
    post("/api/agent/v1/channels/%23general/unmute", { requestId: "r-2" }),
    "#general",
    principal,
    {
      setAgentChannelMuted: async (...args) => {
        calls.push(args);
      },
      setAgentThreadFollowed: async () => {},
    },
  );
  expect(calls).toEqual([["workspace-1", "agent-1", "#general", false]]);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({
    protocolMajor: 1,
    requestId: "r-2",
    target: "#general",
    muted: false,
  });
});

test("unmute returns the exact validation text as a plain-text 400 body", async () => {
  const result = await handleAgentChannelUnmutePost(
    post("/api/agent/v1/channels/%40ada/unmute"),
    "@ada",
    principal,
    { setAgentChannelMuted: async () => {}, setAgentThreadFollowed: async () => {} },
  );
  expect(result.status).toBe(400);
  expect(await result.text()).toBe("mute requires a channel target");
});

test("unfollow forwards the decoded channel thread target", async () => {
  const calls: unknown[] = [];
  const target = "#general:12345678-0000-4000-8000-000000000001";
  const result = await handleAgentThreadUnfollowPost(
    post(`/api/agent/v1/threads/${encodeURIComponent(target)}/unfollow`, { requestId: "r-3" }),
    target,
    principal,
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async (...args) => {
        calls.push(args);
      },
    },
  );
  expect(calls).toEqual([["workspace-1", "agent-1", target, false]]);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({
    protocolMajor: 1,
    requestId: "r-3",
    target,
    followed: false,
  });
});

test("unfollow returns the exact validation text as a plain-text 400 body", async () => {
  const result = await handleAgentThreadUnfollowPost(
    post("/api/agent/v1/threads/%23general/unfollow"),
    "#general",
    principal,
    { setAgentChannelMuted: async () => {}, setAgentThreadFollowed: async () => {} },
  );
  expect(result.status).toBe(400);
  expect(await result.text()).toBe("unfollow requires a channel thread target");
});

test("unfollow hides an unexpected repository failure behind a generic message", async () => {
  const target = "#general:12345678-0000-4000-8000-000000000001";
  const result = await handleAgentThreadUnfollowPost(
    post(`/api/agent/v1/threads/${encodeURIComponent(target)}/unfollow`),
    target,
    principal,
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {
        throw new Error("database password leaked");
      },
    },
  );
  expect(result.status).toBe(400);
  expect(await result.text()).toBe("thread unfollow failed");
});
