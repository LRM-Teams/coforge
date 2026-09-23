import { expect, test } from "bun:test";
import { handleAgentChannelsPost } from "../src/routes/api/agent/v1/channels";
import {
  handleAgentChannelGet,
  handleAgentChannelPatch,
} from "../src/routes/api/agent/v1/channels_.$channel";
import {
  handleAgentChannelMembersDelete,
  handleAgentChannelMembersGet,
  handleAgentChannelMembersPost,
} from "../src/routes/api/agent/v1/channels_.$channel.members";
import { handleAgentChannelJoinPost } from "../src/routes/api/agent/v1/channels_.$channel.join";
import { handleAgentChannelLeavePost } from "../src/routes/api/agent/v1/channels_.$channel.leave";
import { handleAgentChannelArchivePost } from "../src/routes/api/agent/v1/channels_.$channel.archive";
import { handleAgentChannelUnarchivePost } from "../src/routes/api/agent/v1/channels_.$channel.unarchive";
import { AgentChannelManagementError } from "../src/server/conversations/agent-channel-management-error.server";
import type { AgentChannelManagementRepository } from "../src/server/conversations/agent-channel-management.server";

const principal = { workspaceId: "workspace-1", agentId: "agent-1" };
const get = (path: string) => new Request(`https://server.example${path}`);
const post = (path: string, body?: unknown) =>
  new Request(`https://server.example${path}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const del = (path: string, body?: unknown) =>
  new Request(`https://server.example${path}`, {
    method: "DELETE",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function fakeRepository(overrides: Partial<AgentChannelManagementRepository> = {}) {
  const fail = (name: string) => async () => {
    throw new Error(`unexpected call: ${name}`);
  };
  return {
    info: fail("info"),
    members: fail("members"),
    join: fail("join"),
    leave: fail("leave"),
    create: fail("create"),
    update: fail("update"),
    setArchived: fail("setArchived"),
    addMember: fail("addMember"),
    removeMember: fail("removeMember"),
    ...overrides,
  } as AgentChannelManagementRepository;
}

test("POST /channels creates a channel and echoes the caller's idempotencyKey", async () => {
  const calls: unknown[] = [];
  const result = await handleAgentChannelsPost(
    post("/api/agent/v1/channels", { idempotencyKey: "r-1", name: "#eng", description: "Eng" }),
    principal,
    fakeRepository({
      create: async (...args) => {
        calls.push(args);
        return { target: "#eng", channel: { id: "id-1", name: "#eng", description: "Eng" } };
      },
    }),
  );
  expect(calls).toEqual([["workspace-1", "agent-1", "#eng", "Eng"]]);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({
    protocolMajor: 1,
    idempotencyKey: "r-1",
    target: "#eng",
    channel: { id: "id-1", name: "#eng", description: "Eng" },
  });
});

test("POST /channels requires name and returns a plain-text 400", async () => {
  const result = await handleAgentChannelsPost(
    post("/api/agent/v1/channels", {}),
    principal,
    fakeRepository(),
  );
  expect(result.status).toBe(400);
  expect(await result.text()).toBe("name is required");
});

test("POST /channels maps a declared AgentChannelManagementError to its status and message", async () => {
  const result = await handleAgentChannelsPost(
    post("/api/agent/v1/channels", { name: "eng" }),
    principal,
    fakeRepository({
      create: async () => {
        throw new AgentChannelManagementError(403, "this Agent does not belong to the Workspace");
      },
    }),
  );
  expect(result.status).toBe(403);
  expect(await result.text()).toBe("this Agent does not belong to the Workspace");
});

test("POST /channels hides an unexpected repository failure behind a generic message", async () => {
  const result = await handleAgentChannelsPost(
    post("/api/agent/v1/channels", { name: "eng" }),
    principal,
    fakeRepository({
      create: async () => {
        throw new Error("database password leaked");
      },
    }),
  );
  expect(result.status).toBe(400);
  expect(await result.text()).toBe("channel create failed");
});

test("GET /channels/:channel returns the info envelope", async () => {
  const result = await handleAgentChannelGet(
    get("/api/agent/v1/channels/%23eng?idempotencyKey=r-2"),
    "#eng",
    principal,
    fakeRepository({
      info: async (workspaceId, agentId, target) => {
        expect([workspaceId, agentId, target]).toEqual(["workspace-1", "agent-1", "#eng"]);
        return {
          id: "id-1",
          name: "#eng",
          description: "",
          archived: false,
          joined: true,
          muted: false,
          memberCounts: { agents: 1, humans: 0 },
          channelRole: "member",
          channelCapabilities: {
            post: true,
            leave: true,
            add_member: true,
            update: false,
            archive: false,
            unarchive: false,
            remove_member: false,
            manage_roles: false,
          },
        };
      },
    }),
  );
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    protocolMajor: 1,
    idempotencyKey: "r-2",
    channel: { name: "#eng" },
  });
});

test("GET /channels/:channel forwards a bound Project through unchanged", async () => {
  const result = await handleAgentChannelGet(
    get("/api/agent/v1/channels/%23launch-eng?idempotencyKey=r-3"),
    "#launch-eng",
    principal,
    fakeRepository({
      info: async () => ({
        id: "id-1",
        name: "#launch-eng",
        description: "",
        archived: false,
        joined: true,
        muted: false,
        memberCounts: { agents: 1, humans: 0 },
        channelCapabilities: {
          post: true,
          leave: true,
          add_member: true,
          update: false,
          archive: false,
          unarchive: false,
          remove_member: false,
          manage_roles: false,
        },
        project: { id: "project-1", name: "Launch", slug: "launch", githubFullName: "acme/launch" },
      }),
    }),
  );
  expect(result.status).toBe(200);
  expect((await result.json()).channel.project).toEqual({
    id: "project-1",
    name: "Launch",
    slug: "launch",
    githubFullName: "acme/launch",
  });
});

test("GET /channels/:channel maps a not-found channel to its declared 404 status and text", async () => {
  const result = await handleAgentChannelGet(
    get("/api/agent/v1/channels/%23missing"),
    "#missing",
    principal,
    fakeRepository({
      info: async () => {
        throw new AgentChannelManagementError(404, "channel not found");
      },
    }),
  );
  expect(result.status).toBe(404);
  expect(await result.text()).toBe("channel not found");
});

test("PATCH /channels/:channel forwards name/description and returns the info envelope", async () => {
  const calls: unknown[] = [];
  const result = await handleAgentChannelPatch(
    post("/api/agent/v1/channels/%23eng", { description: "Eng team" }),
    "#eng",
    principal,
    fakeRepository({
      update: async (...args) => {
        calls.push(args);
        return {
          id: "id-1",
          name: "#eng",
          description: "Eng team",
          archived: false,
          joined: true,
          muted: false,
          memberCounts: { agents: 1, humans: 0 },
          channelRole: "admin",
          channelAdminBasis: "channel_role" as const,
          channelCapabilities: {
            post: true,
            leave: true,
            add_member: true,
            update: true,
            archive: true,
            unarchive: true,
            remove_member: true,
            manage_roles: false,
          },
        };
      },
    }),
  );
  expect(calls).toEqual([
    ["workspace-1", "agent-1", "#eng", { name: undefined, description: "Eng team" }],
  ]);
  expect(result.status).toBe(200);
  expect((await result.json()).channel.description).toBe("Eng team");
});

test("GET /channels/:channel/members returns the roster envelope", async () => {
  const result = await handleAgentChannelMembersGet(
    get("/api/agent/v1/channels/%23eng/members"),
    "#eng",
    principal,
    fakeRepository({
      members: async () => ({
        target: "#eng",
        agents: [
          {
            name: "helper",
            displayName: "Helper",
            description: "",
            serverRole: "member",
            channelRole: "member",
            self: true,
            status: "online",
          },
        ],
        humans: [],
      }),
    }),
  );
  expect(result.status).toBe(200);
  const body = await result.json();
  expect(body.target).toBe("#eng");
  expect(body.agents).toHaveLength(1);
});

test("POST /channels/:channel/members adds a member and returns its envelope", async () => {
  const calls: unknown[] = [];
  const result = await handleAgentChannelMembersPost(
    post("/api/agent/v1/channels/%23eng/members", { user: "@alice" }),
    "#eng",
    principal,
    fakeRepository({
      addMember: async (...args) => {
        calls.push(args);
        return {
          target: "#eng",
          member: { kind: "user", handle: "@alice" },
          added: true,
          alreadyMember: false,
        };
      },
    }),
  );
  expect(calls).toEqual([["workspace-1", "agent-1", "#eng", { user: "@alice", agent: undefined }]]);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ target: "#eng", added: true, alreadyMember: false });
});

test("POST /channels/:channel/members maps an unknown handle to its declared 404 status and text", async () => {
  const result = await handleAgentChannelMembersPost(
    post("/api/agent/v1/channels/%23eng/members", { user: "@nobody" }),
    "#eng",
    principal,
    fakeRepository({
      addMember: async () => {
        throw new AgentChannelManagementError(404, "member not found: @nobody");
      },
    }),
  );
  expect(result.status).toBe(404);
  expect(await result.text()).toBe("member not found: @nobody");
});

test("POST /channels/:channel/members maps an errorCode-carrying failure to a JSON envelope", async () => {
  const result = await handleAgentChannelMembersPost(
    post("/api/agent/v1/channels/%23eng/members", { agent: "@ghost" }),
    "#eng",
    principal,
    fakeRepository({
      addMember: async () => {
        throw new AgentChannelManagementError(
          404,
          "@ghost is not visible to you.",
          "agent_not_visible",
        );
      },
    }),
  );
  expect(result.status).toBe(404);
  expect(await result.json()).toEqual({
    ok: false,
    errorCode: "agent_not_visible",
    error: "@ghost is not visible to you.",
  });
});

test("DELETE /channels/:channel/members removes a member and returns its envelope", async () => {
  const calls: unknown[] = [];
  const result = await handleAgentChannelMembersDelete(
    del("/api/agent/v1/channels/%23eng/members", { agent: "@reviewer" }),
    "#eng",
    principal,
    fakeRepository({
      removeMember: async (...args) => {
        calls.push(args);
        return { target: "#eng", removed: true, wasMember: true };
      },
    }),
  );
  expect(calls).toEqual([
    ["workspace-1", "agent-1", "#eng", { user: undefined, agent: "@reviewer" }],
  ]);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ target: "#eng", removed: true, wasMember: true });
});

test("join/leave/archive/unarchive routes forward the target and return their declared envelopes", async () => {
  const joinResult = await handleAgentChannelJoinPost(
    post("/api/agent/v1/channels/%23eng/join"),
    "#eng",
    principal,
    fakeRepository({
      join: async () => ({ target: "#eng", joined: true, alreadyJoined: false }),
    }),
  );
  expect(await joinResult.json()).toMatchObject({
    target: "#eng",
    joined: true,
    alreadyJoined: false,
  });

  const leaveResult = await handleAgentChannelLeavePost(
    post("/api/agent/v1/channels/%23eng/leave"),
    "#eng",
    principal,
    fakeRepository({
      leave: async () => ({ target: "#eng", joined: false, wasMember: true }),
    }),
  );
  expect(await leaveResult.json()).toMatchObject({
    target: "#eng",
    joined: false,
    wasMember: true,
  });

  const leaveDenied = await handleAgentChannelLeavePost(
    post("/api/agent/v1/channels/%23general/leave"),
    "#general",
    principal,
    fakeRepository({
      leave: async () => {
        throw new AgentChannelManagementError(400, "cannot leave #general");
      },
    }),
  );
  expect(leaveDenied.status).toBe(400);
  expect(await leaveDenied.text()).toBe("cannot leave #general");

  const archiveCalls: unknown[] = [];
  const archiveResult = await handleAgentChannelArchivePost(
    post("/api/agent/v1/channels/%23eng/archive"),
    "#eng",
    principal,
    fakeRepository({
      setArchived: async (...args) => {
        archiveCalls.push(args);
        return { target: "#eng", archived: true };
      },
    }),
  );
  expect(archiveCalls).toEqual([["workspace-1", "agent-1", "#eng", true]]);
  expect(await archiveResult.json()).toMatchObject({ target: "#eng", archived: true });

  const unarchiveCalls: unknown[] = [];
  const unarchiveResult = await handleAgentChannelUnarchivePost(
    post("/api/agent/v1/channels/%23eng/unarchive"),
    "#eng",
    principal,
    fakeRepository({
      setArchived: async (...args) => {
        unarchiveCalls.push(args);
        return { target: "#eng", archived: false };
      },
    }),
  );
  expect(unarchiveCalls).toEqual([["workspace-1", "agent-1", "#eng", false]]);
  expect(await unarchiveResult.json()).toMatchObject({ target: "#eng", archived: false });
});
