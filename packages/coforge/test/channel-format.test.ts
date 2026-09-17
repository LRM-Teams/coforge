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
} from "../src/channel-format";

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
        role: "member",
        status: "online",
        activity: "working",
        activityDetail: "running tests",
      },
      {
        name: "reviewer",
        displayName: "Reviewer",
        description: "",
        role: "admin",
        status: "offline",
      },
    ],
    humans: [
      { username: "frank", role: "owner" },
      { username: "alice", role: "member" },
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
      "  - @assistant (online; working: running tests) — helper",
      "  - @reviewer (offline) (admin)",
      "",
      "### Humans",
      "  - @frank (owner)",
      "  - @alice",
    ].join("\n"),
  );
});

test("agent status label composition: plain online, activity with and without detail, offline, unknown", () => {
  const label = (agent: Parameters<typeof formatChannelMembers>[0]["agents"][number]) =>
    formatChannelMembers({ target: "#x", agents: [agent], humans: [] })
      .split("\n")
      .find((line) => line.startsWith("  - @"));
  const base = { name: "a", displayName: "A", description: "", role: "member" } as const;
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
  expect(text).toContain("### Agents\n  (none)");
  expect(text).toContain("### Humans\n  (none)");
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
