import { expect, test } from "bun:test";
import {
  deriveChannelAdminBasis,
  deriveChannelCapabilities,
} from "#src/server/conversations/channel-authority.server";

test("deriveChannelAdminBasis: server_role wins when both apply, channel_role when only stored, none otherwise", () => {
  expect(deriveChannelAdminBasis("owner", "member")).toBe("server_role");
  expect(deriveChannelAdminBasis("admin", "admin")).toBe("server_role");
  expect(deriveChannelAdminBasis("member", "admin")).toBe("channel_role");
  expect(deriveChannelAdminBasis("member", "member")).toBeUndefined();
  expect(deriveChannelAdminBasis("member", undefined)).toBeUndefined();
  expect(deriveChannelAdminBasis(undefined, undefined)).toBeUndefined();
  // Not a recognized server role (e.g. an Agent row that failed to load): never elevated.
  expect(deriveChannelAdminBasis("owner-typo", "member")).toBeUndefined();
});

const ADMIN_CAPS = {
  update: true,
  archive: true,
  unarchive: true,
  remove_member: true,
} as const;
const NO_ADMIN_CAPS = {
  update: false,
  archive: false,
  unarchive: false,
  remove_member: false,
} as const;

test("deriveChannelCapabilities: plain active member gets post/leave/add_member only", () => {
  expect(
    deriveChannelCapabilities({
      isHuman: true,
      isActiveMember: true,
      isGeneral: false,
      adminBasis: undefined,
    }),
  ).toEqual({
    post: true,
    leave: true,
    add_member: true,
    manage_roles: false,
    ...NO_ADMIN_CAPS,
  });
});

test("deriveChannelCapabilities: channel admin (channel_role basis) additionally gets the admin set, and manage_roles when human", () => {
  const human = deriveChannelCapabilities({
    isHuman: true,
    isActiveMember: true,
    isGeneral: false,
    adminBasis: "channel_role",
  });
  expect(human).toEqual({
    post: true,
    leave: true,
    add_member: true,
    manage_roles: true,
    ...ADMIN_CAPS,
  });
  // Same basis, but an Agent: never manage_roles (Raft: no Agent command changes channel roles).
  const agent = deriveChannelCapabilities({
    isHuman: false,
    isActiveMember: true,
    isGeneral: false,
    adminBasis: "channel_role",
  });
  expect(agent).toEqual({ ...human, manage_roles: false });
});

test("deriveChannelCapabilities: server admin (server_role basis) gets the admin set even without active membership", () => {
  const capabilities = deriveChannelCapabilities({
    isHuman: true,
    isActiveMember: false,
    isGeneral: false,
    adminBasis: "server_role",
  });
  expect(capabilities).toEqual({
    post: false,
    leave: false,
    add_member: false,
    manage_roles: true,
    ...ADMIN_CAPS,
  });
});

test("deriveChannelCapabilities: on #general an admin only edits the channel info (never its name, enforced by the write), for either basis, human or Agent", () => {
  for (const adminBasis of ["server_role", "channel_role"] as const) {
    for (const isHuman of [true, false]) {
      const capabilities = deriveChannelCapabilities({
        isHuman,
        isActiveMember: true,
        isGeneral: true,
        adminBasis,
      });
      expect(capabilities).toEqual({
        post: true,
        leave: false,
        add_member: true,
        manage_roles: false,
        ...NO_ADMIN_CAPS,
        update: true,
      });
    }
  }
});

test("deriveChannelCapabilities: a left (soft-removed) member has no capabilities at all, even if they were the channel admin", () => {
  // A left member's own membership row is excluded by ACTIVE_MEMBER_WHERE upstream, so the
  // caller passes isActiveMember: false and no admin basis for a soft-left admin's OWN row —
  // but if they still independently hold server_role authority, that basis alone still grants
  // the admin set (see the server-admin case above). This case is the plain "left, no other
  // authority" member: nothing at all.
  const capabilities = deriveChannelCapabilities({
    isHuman: true,
    isActiveMember: false,
    isGeneral: false,
    adminBasis: undefined,
  });
  expect(capabilities).toEqual({
    post: false,
    leave: false,
    add_member: false,
    manage_roles: false,
    ...NO_ADMIN_CAPS,
  });
});

test("deriveChannelCapabilities: a non-member (never joined) has no capabilities", () => {
  const capabilities = deriveChannelCapabilities({
    isHuman: true,
    isActiveMember: false,
    isGeneral: false,
    adminBasis: undefined,
  });
  expect(Object.values(capabilities).every((allowed) => allowed === false)).toBe(true);
});
