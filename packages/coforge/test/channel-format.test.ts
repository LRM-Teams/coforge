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

test("formatChannelInfo prints a real description, singular member nouns, and update shares the renderer", () => {
  expect(formatChannelUpdate).toBe(formatChannelInfo);
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
  expect(text).toContain("Members: 2 (1 agent, 1 human)");
});

test("formatChannelMembers tags self and admin/owner roles on both Agents and humans", () => {
  const text = formatChannelMembers({
    target: "#engineering",
    agents: [
      {
        name: "assistant",
        displayName: "Assistant",
        description: "helper",
        role: "member",
        self: true,
      },
      { name: "reviewer", displayName: "Reviewer", description: "", role: "admin", self: false },
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
      "  - @assistant (self) — helper",
      "  - @reviewer (admin)",
      "",
      "### Humans",
      "  - @frank (owner)",
      "  - @alice",
    ].join("\n"),
  );
});

test("formatChannelMembers prints (none) for an empty section", () => {
  const text = formatChannelMembers({ target: "#empty", agents: [], humans: [] });
  expect(text).toContain("### Agents\n  (none)");
  expect(text).toContain("### Humans\n  (none)");
});

test("channel action renderers match the brief's exact one-line confirmations", () => {
  expect(formatChannelJoin({ target: "#engineering" })).toBe("Joined #engineering.");
  expect(formatChannelLeave({ target: "#engineering" })).toBe("Left #engineering.");
  expect(formatChannelCreate({ channel: { id: "abc-123", name: "#engineering" } })).toBe(
    "Created #engineering. ID: abc-123",
  );
  expect(formatChannelArchive({ target: "#engineering", archived: true })).toBe(
    "Archived #engineering.",
  );
  expect(formatChannelArchive({ target: "#engineering", archived: false })).toBe(
    "Unarchived #engineering.",
  );
  expect(formatChannelAddMember({ target: "#engineering", member: { handle: "@alice" } })).toBe(
    "Added @alice to #engineering.",
  );
  expect(formatChannelRemoveMember("#engineering", "@alice")).toBe(
    "Removed @alice from #engineering.",
  );
});
