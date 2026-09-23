import { expect, test } from "bun:test";
import {
  formatChannelAddMember,
  formatChannelArchive,
  formatChannelCreate,
  formatChannelInfo,
  formatChannelJoin,
  formatChannelLeave,
  formatChannelMembers,
  formatChannelRemoveMember,
  formatChannelUpdate,
} from "#src/channel-format";

const NO_CAPABILITIES = {
  post: false,
  leave: false,
  add_member: false,
  update: false,
  archive: false,
  unarchive: false,
  remove_member: false,
  manage_roles: false,
} as const;

test("formatChannelInfo renders the full info block, including an empty description", () => {
  const text = formatChannelInfo({
    channel: {
      id: "11111111-0000-0000-0000-000000000000",
      name: "#engineering",
      description: "",
      archived: false,
      joined: true,
      muted: false,
      memberCounts: { agents: 2, humans: 3 },
      channelCapabilities: NO_CAPABILITIES,
    },
  });
  expect(text).toBe(
    [
      "## Channel",
      "",
      "Channel: #engineering",
      "ID: 11111111-0000-0000-0000-000000000000",
      "Visibility: public",
      "Joined: yes",
      "Muted: no",
      "Archived: no",
      "Description: (none)",
      "Members: 5 (2 agents, 3 humans)",
      "",
      'More: coforge channel members "#engineering"',
    ].join("\n"),
  );
});

test("formatChannelInfo prints a Project line, with github=, between Description and Members when the channel is bound", () => {
  const text = formatChannelInfo({
    channel: {
      id: "id",
      name: "#launch-eng",
      description: "Launch engineering",
      archived: false,
      joined: true,
      muted: false,
      memberCounts: { agents: 1, humans: 2 },
      channelCapabilities: NO_CAPABILITIES,
      project: {
        id: "project-1",
        name: "Launch",
        slug: "launch",
        githubFullName: "acme/launch",
        githubHtmlUrl: "https://github.com/acme/launch",
      },
    },
  });
  expect(text).toBe(
    [
      "## Channel",
      "",
      "Channel: #launch-eng",
      "ID: id",
      "Visibility: public",
      "Joined: yes",
      "Muted: no",
      "Archived: no",
      "Description: Launch engineering",
      "Project: Launch (launch) github=acme/launch",
      "Members: 3 (1 agents, 2 humans)",
      "",
      'More: coforge channel members "#launch-eng"',
    ].join("\n"),
  );
});

test("formatChannelInfo prints a Project line with no github= when the Project has no bound repository", () => {
  const text = formatChannelInfo({
    channel: {
      id: "id",
      name: "#docs",
      description: "",
      archived: false,
      joined: true,
      muted: false,
      memberCounts: { agents: 0, humans: 1 },
      channelCapabilities: NO_CAPABILITIES,
      project: { id: "project-2", name: "Docs", slug: "docs" },
    },
  });
  expect(text).toContain("Project: Docs (docs)");
  expect(text).not.toContain("github=");
});

test("formatChannelInfo omits the Project line entirely for a channel with no bound Project", () => {
  const text = formatChannelInfo({
    channel: {
      id: "id",
      name: "#general",
      description: "",
      archived: false,
      joined: true,
      muted: false,
      memberCounts: { agents: 0, humans: 1 },
      channelCapabilities: NO_CAPABILITIES,
    },
  });
  expect(text).not.toContain("Project:");
});

test("formatChannelInfo prints a real description and always uses plural member nouns, like Raft, even for a count of one", () => {
  const text = formatChannelInfo({
    channel: {
      id: "id",
      name: "#solo",
      description: "One agent, one human.",
      archived: true,
      joined: false,
      muted: true,
      memberCounts: { agents: 1, humans: 1 },
      channelCapabilities: NO_CAPABILITIES,
    },
  });
  expect(text).toContain("Description: One agent, one human.");
  expect(text).toContain("Joined: no");
  expect(text).toContain("Muted: yes");
  expect(text).toContain("Archived: yes");
  // Never singularized, unlike the old brief's draft: Raft's formatChannelInfo always says
  // "agents"/"humans", even at a count of one.
  expect(text).toContain("Members: 2 (1 agents, 1 humans)");
});

test("formatChannelInfo renders channel role, admin basis, and only the callable capabilities, between Joined and Muted (Raft's order); hides the uninformative default channel role", () => {
  const text = formatChannelInfo({
    channel: {
      id: "id",
      name: "#eng",
      description: "",
      archived: false,
      joined: true,
      muted: false,
      memberCounts: { agents: 1, humans: 0 },
      channelRole: "admin",
      channelAdminBasis: "channel_role",
      channelCapabilities: {
        ...NO_CAPABILITIES,
        post: true,
        leave: true,
        add_member: true,
        update: true,
        archive: true,
        unarchive: true,
        remove_member: true,
      },
    },
  });
  expect(text.split("\n")).toEqual([
    "## Channel",
    "",
    "Channel: #eng",
    "ID: id",
    "Visibility: public",
    "Joined: yes",
    "Channel role: admin",
    "Channel admin basis: channel_role",
    "Channel capabilities: post, leave, add_member, update, archive, unarchive, remove_member",
    "Muted: no",
    "Archived: no",
    "Description: (none)",
    "Members: 1 (1 agents, 0 humans)",
    "",
    'More: coforge channel members "#eng"',
  ]);
  // A plain "member" channel role is the uninformative default; the CLI hides it, the same
  // convention `roleSuffix`/`(admin)` already uses for server roles.
  const memberText = formatChannelInfo({
    channel: {
      id: "id",
      name: "#eng",
      description: "",
      archived: false,
      joined: true,
      muted: false,
      memberCounts: { agents: 1, humans: 0 },
      channelRole: "member",
      channelCapabilities: NO_CAPABILITIES,
    },
  });
  expect(memberText).not.toContain("Channel role:");
  expect(memberText).not.toContain("Channel admin basis:");
  expect(memberText).not.toContain("Channel capabilities:");
});

test("formatChannelUpdate is its own renderer, distinct from formatChannelInfo, matching Raft's one-line update confirmation", () => {
  expect(formatChannelUpdate).not.toBe(formatChannelInfo);
  expect(formatChannelUpdate({ channel: { name: "#engineering" } })).toBe(
    "Updated #engineering (public).",
  );
});

test("formatChannelMembers renders admin/owner roles and live status on Agents, with no self tag; role only on humans", () => {
  const text = formatChannelMembers({
    target: "#engineering",
    agents: [
      {
        name: "assistant",
        displayName: "Assistant",
        description: "helper",
        serverRole: "member",
        status: "online",
        activity: "working",
        activityDetail: "running tests",
      },
      {
        name: "reviewer",
        displayName: "Reviewer",
        description: "",
        serverRole: "admin",
        status: "offline",
      },
    ],
    humans: [
      { username: "frank", serverRole: "owner" },
      { username: "alice", serverRole: "member" },
    ],
  });
  expect(text).toBe(
    [
      "## Channel Members",
      "",
      "Channel: #engineering",
      "Members means join/post authority for this surface.",
      "",
      "### Agents",
      "Server and stored channel roles are shown separately when available.",
      "  - @assistant (online; working: running tests) — helper",
      "  - @reviewer (offline) (admin) [server role=admin]",
      "",
      "### Humans",
      "Server and stored channel roles are shown separately when available.",
      "  - @frank (owner) [server role=owner]",
      "  - @alice",
    ].join("\n"),
  );
});

test("formatChannelMembers appends the bracketed server/channel role detail, in Raft's channelMemberRoleDetail order, only when informative", () => {
  const text = formatChannelMembers({
    target: "#engineering",
    agents: [
      {
        name: "reviewer",
        displayName: "Reviewer",
        description: "",
        serverRole: "admin",
        channelRole: "member",
        channelAdminBasis: "server_role",
        status: "offline",
      },
      {
        name: "helper",
        displayName: "Helper",
        description: "",
        serverRole: "member",
        channelRole: "admin",
        channelAdminBasis: "channel_role",
        status: "offline",
      },
      {
        name: "plain",
        displayName: "Plain",
        description: "",
        serverRole: "member",
        channelRole: "member",
        status: "offline",
      },
    ],
    humans: [{ username: "frank", serverRole: "member", channelRole: "member" }],
  });
  const lines = text.split("\n");
  expect(lines).toContain(
    "  - @reviewer (offline) (admin) [server role=admin, admin via=server_role]",
  );
  expect(lines).toContain("  - @helper (offline) [channel role=admin, admin via=channel_role]");
  // Both roles default ("member"): no bracket, and no `(role)` tag either.
  expect(lines).toContain("  - @plain (offline)");
  expect(lines).toContain("  - @frank");
});

test("agent status label composition: plain online, activity with and without detail, offline, unknown", () => {
  const label = (agent: Parameters<typeof formatChannelMembers>[0]["agents"][number]) =>
    formatChannelMembers({ target: "#x", agents: [agent], humans: [] })
      .split("\n")
      .find((line) => line.startsWith("  - @"));
  const base = { name: "a", displayName: "A", description: "", serverRole: "member" } as const;
  expect(label({ ...base, status: "online" })).toBe("  - @a (online)");
  expect(label({ ...base, status: "online", activity: "thinking" })).toBe(
    "  - @a (online; thinking)",
  );
  expect(
    label({ ...base, status: "online", activity: "working", activityDetail: "running tests" }),
  ).toBe("  - @a (online; working: running tests)");
  expect(label({ ...base, status: "offline" })).toBe("  - @a (offline)");
  expect(label({ ...base, status: "unknown" })).toBe("  - @a (unknown)");
});

test("formatChannelMembers prints (none) for an empty section", () => {
  const text = formatChannelMembers({ target: "#empty", agents: [], humans: [] });
  expect(text).toContain(
    "### Agents\nServer and stored channel roles are shown separately when available.\n  (none)",
  );
  expect(text).toContain(
    "### Humans\nServer and stored channel roles are shown separately when available.\n  (none)",
  );
});

test("formatChannelJoin matches Raft's join confirmation, including the still-arrives block, and its already-joined variant", () => {
  expect(formatChannelJoin({ target: "#engineering", alreadyJoined: false })).toBe(
    [
      "Joined #engineering. You can now send messages there and receive ordinary channel delivery.",
      "Still arrives:",
      "- Personal @mentions still reach you even if you later mute ordinary channel updates.",
      "- Threads you started or follow stay followed even if you later mute this channel.",
    ].join("\n"),
  );
  expect(formatChannelJoin({ target: "#engineering", alreadyJoined: true })).toBe(
    "Already joined #engineering.",
  );
});

test("formatChannelLeave matches Raft's leave confirmation and its not-a-member variant", () => {
  expect(formatChannelLeave({ target: "#engineering", wasMember: true })).toBe(
    "Left #engineering. You can still inspect visible public channel history there, but you can no longer send or receive ordinary channel delivery until you join the public channel again or a human re-adds you to a private channel.",
  );
  expect(formatChannelLeave({ target: "#engineering", wasMember: false })).toBe(
    "Already not joined in #engineering.",
  );
});

test("formatChannelCreate matches Raft's create confirmation; CoForge channels are always (public)", () => {
  expect(formatChannelCreate({ channel: { name: "#engineering" } })).toBe(
    "Created #engineering (public). You are joined and can send messages there.",
  );
});

test("formatChannelArchive/unarchive match Raft's archive confirmations", () => {
  expect(formatChannelArchive({ target: "#engineering", archived: true })).toBe(
    "Archived #engineering. The channel is read-only until unarchived.",
  );
  expect(formatChannelArchive({ target: "#engineering", archived: false })).toBe(
    "Unarchived #engineering. Messages and other writes are enabled again.",
  );
});

test("formatChannelAddMember matches Raft's add-member confirmation, agent vs. user wording, and the already-a-member variant", () => {
  expect(
    formatChannelAddMember({
      target: "#engineering",
      member: { kind: "agent", handle: "@reviewer" },
      alreadyMember: false,
    }),
  ).toBe("Added @reviewer to #engineering as an agent.");
  expect(
    formatChannelAddMember({
      target: "#engineering",
      member: { kind: "user", handle: "@alice" },
      alreadyMember: false,
    }),
  ).toBe("Added @alice to #engineering as a user.");
  expect(
    formatChannelAddMember({
      target: "#engineering",
      member: { kind: "user", handle: "@alice" },
      alreadyMember: true,
    }),
  ).toBe("@alice is already in #engineering.");
});

test("formatChannelRemoveMember matches Raft's remove-member confirmation and its not-a-member variant", () => {
  expect(formatChannelRemoveMember("#engineering", "@alice", true)).toBe(
    "Removed @alice from #engineering.",
  );
  expect(formatChannelRemoveMember("#engineering", "@alice", false)).toBe(
    "@alice was not in #engineering.",
  );
});
