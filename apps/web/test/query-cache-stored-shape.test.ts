import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { InferDataFromTag, QueryKey } from "@tanstack/react-query";

import {
  STORED_KINDS,
  STORED_SHAPE_VERSION,
  isStoredData,
  storedKindOf,
  storedQueryData,
} from "#src/features/cache-persistence/persisted-queries";
import {
  channelNamesQuery,
  directConversationQuery,
  publicChannelQuery,
  savedMessagesQuery,
} from "#src/features/conversations/conversation-queries";
import {
  sidebarChannelsQuery,
  sidebarDirectsQuery,
} from "#src/features/conversations/sidebar-collections";

/**
 * What the browser's copy of the Query cache holds is read back by later builds, so the shape of
 * every kept kind is a contract: `STORED_SHAPE_VERSION` (`persisted-queries.ts`) must be raised
 * when a row written by the previous version could no longer be opened as it is.
 *
 * The contract is checked in two links, because neither alone can see it. Each fixture below is
 * typed as the data its query really returns (`fixture`), so a change to a server return type or a
 * query fails `bun run typecheck` here until the fixture follows. Following it changes the shape
 * this file computes from what the fixture would store, which no longer matches what is pinned for
 * the version, and that fails `bun test` until the version is raised and the new shape pinned. A
 * change that only adds an optional field touches neither link: rows without it still read.
 *
 * The fixtures are frozen: edit one only when a type change forces it.
 */

type Fixture = { name: string; queryKey: QueryKey; data: unknown };

/** A kept query's data as its query really returns it: the type comes from the query definition,
 * so a fixture that has drifted from it does not type-check. */
function fixture<Options extends { queryKey: QueryKey }>(
  name: string,
  options: Options,
  data: InferDataFromTag<unknown, Options["queryKey"]>,
): Fixture {
  return { name, queryKey: options.queryKey, data };
}

const streamPositions = { "chat:workspace:w1": { offset: 2, epoch: "e1" } };
const message = {
  id: "m1",
  sequence: 1,
  threadRootId: undefined,
  senderMemberId: "member-1",
  senderKind: "user" as const,
  senderName: "Ada",
  senderHandle: "ada",
  senderAgentId: undefined,
  senderDeleted: false,
  senderAvatarUrl: null,
  body: "hello",
  createdAt: "2026-09-30T00:00:00.000Z",
  mentions: [{ kind: "agent" as const, actorId: "agent-1", handle: "helper", label: "Helper" }],
  attachments: [
    { id: "a1", fileName: "notes.png", contentType: "image/png", sizeBytes: 12, previewUrl: "u" },
  ],
  reactions: [{ emoji: "👍", count: 1, reactors: [{ id: "user-1", label: "Ada" }] }],
  actionCard: undefined,
};
// A direct conversation's stream does not send `senderMemberId`.
const { senderMemberId: _senderMemberId, ...directMessage } = message;
const windowFields = {
  senderMemberId: "member-1",
  readThroughSequence: 1,
  threads: {
    m1: {
      replyCount: 1,
      lastReplySequence: 2,
      lastReplyAt: "2026-09-30T00:01:00.000Z",
      unread: 0,
      latestReplies: [
        {
          id: "r1",
          sequence: 2,
          senderName: "Ada",
          senderAvatarUrl: null,
          senderDeleted: false,
          body: "reply",
          createdAt: "2026-09-30T00:01:00.000Z",
        },
      ],
    },
  },
  threadReadThrough: { m1: 2 },
  viewerId: "user-1",
  mentionables: [
    {
      kind: "user" as const,
      id: "user-1",
      handle: "ada",
      label: "Ada",
      fullName: "Ada Lovelace",
      description: "",
      avatarUrl: null,
      mentionScore: 0,
    },
  ],
  hasOlder: false,
  hasNewer: false,
};

const fixtures = [
  fixture("channel window", publicChannelQuery("c1").query, {
    pages: [
      {
        ...windowFields,
        conversationId: "c1",
        name: "general",
        description: "",
        archived: false,
        project: undefined,
        coordinatorAgent: undefined,
        muted: false,
        collapseLongMessages: true,
        pinned: false,
        channelCapabilities: {
          post: true,
          leave: true,
          add_member: true,
          update: true,
          archive: true,
          unarchive: false,
          remove_member: true,
          manage_roles: true,
        },
        canHideGeneral: false,
        canDelete: false,
        canCreateAgents: true,
        canStopAgents: true,
        followedThreadRootIds: ["m1"],
        messages: [message],
      },
    ],
    pageParams: [undefined],
  }),
  fixture("direct window with an Agent", directConversationQuery("d1").query, {
    pages: [
      {
        ...windowFields,
        conversationId: "d1",
        kind: "agent",
        agent: {
          id: "agent-1",
          name: "helper",
          displayName: "Helper",
          deletedAt: null,
          avatarUrl: null,
        },
        dmWritable: true,
        messages: [directMessage],
      },
    ],
    pageParams: [undefined],
  }),
  fixture("direct window with a person", directConversationQuery("d2").query, {
    pages: [
      {
        ...windowFields,
        conversationId: "d2",
        kind: "people",
        peer: { id: "user-2", username: "grace", displayName: "Grace", avatarUrl: null },
        messages: [directMessage],
      },
    ],
    pageParams: [undefined],
  }),
  fixture("sidebar channels", sidebarChannelsQuery("w1"), {
    fetchedAt: 1,
    streamPositions,
    rows: [
      {
        id: "c1",
        name: "general",
        joined: true,
        archived: false,
        muted: false,
        unreadCount: 0,
        hidden: false,
        pinned: false,
        pinSortOrder: null,
      },
    ],
  }),
  fixture("sidebar directs", sidebarDirectsQuery("w1"), {
    fetchedAt: 1,
    viewerId: "user-1",
    streamPositions,
    partial: false,
    rows: [
      {
        conversationId: "d1",
        position: 0,
        peer: { kind: "agent", agentId: "agent-1" },
        pinned: false,
        pinSortOrder: null,
        hidden: false,
        unreadCount: 0,
      },
      {
        conversationId: "d2",
        position: 1,
        peer: {
          kind: "people",
          userId: "user-2",
          username: "grace",
          displayName: "Grace",
          avatarUrl: null,
        },
        pinned: true,
        pinSortOrder: 1,
        hidden: false,
        unreadCount: 2,
      },
    ],
  }),
  fixture("channel names", channelNamesQuery("w1"), {
    streamPositions,
    names: [{ id: "c1", name: "general", description: "", archived: false }],
  }),
  fixture("saved messages", savedMessagesQuery("w1"), {
    streamPositions,
    entries: [
      {
        savedAt: new Date("2026-09-30T00:02:00.000Z"),
        conversation: { id: "c1", channelName: "general", directKey: null },
        message,
      },
    ],
  }),
];

/** What a value is made of, not what it says: each field with the type of what it holds, an array
 * by the distinct shapes of its elements. */
function shapeOf(value: unknown): string {
  if (Array.isArray(value)) return `[${[...new Set(value.map(shapeOf))].sort().join("|")}]`;
  if (value instanceof Date) return "Date";
  if (typeof value === "object" && value !== null) {
    const fields = value as Record<string, unknown>;
    const spelled = Object.keys(fields)
      .sort()
      .map((key) => `${key}:${shapeOf(fields[key])}`);
    return `{${spelled.join(",")}}`;
  }
  return value === null ? "null" : typeof value;
}

const fingerprint = (data: unknown) =>
  createHash("sha256").update(shapeOf(data)).digest("hex").slice(0, 16);

/**
 * The shape each version of the stored data has, per fixture, as `fingerprint` computes it from
 * what a fixture stores. Raising `STORED_SHAPE_VERSION` adds a version here with every kind's
 * shape; an earlier version's entry is history and stays as it was.
 */
const PINNED_SHAPES: Record<number, Record<string, string>> = {
  1: {
    "channel window": "2f68f20584a2fb7b",
    "direct window with an Agent": "2d10aa5a9e972ac8",
    "direct window with a person": "085473f1d4a4eda8",
    "sidebar channels": "0b5b17a03f4362f8",
    "sidebar directs": "d5303ed35079d99a",
    "channel names": "331d221481674004",
    "saved messages": "da415c7e82ad6579",
  },
  // A reaction's reactors are `{ id, label }`, not the `@handle` strings they were, and a window
  // no longer carries the viewer's handle.
  2: {
    "channel window": "44676fdb14e4f430",
    "direct window with an Agent": "97ae348e063eecb4",
    "direct window with a person": "0d0d6367b901566a",
    "sidebar channels": "0b5b17a03f4362f8",
    "sidebar directs": "d5303ed35079d99a",
    "channel names": "331d221481674004",
    "saved messages": "af3437c73adfddaa",
  },
};

describe("the stored shape of the kept queries", () => {
  test("has a fixture for every kept kind", () => {
    const covered = new Set(fixtures.map(({ queryKey }) => storedKindOf(queryKey)));
    expect([...covered].sort()).toEqual([...STORED_KINDS].sort());
  });

  test("is one a restore opens: each fixture is kept, and passes the guard a restore applies", () => {
    for (const { name, queryKey, data } of fixtures) {
      const stored = storedQueryData(queryKey, data);
      expect({ name, kept: stored !== undefined }).toEqual({ name, kept: true });
      expect({ name, readable: isStoredData(queryKey, stored) }).toEqual({ name, readable: true });
    }
  });

  test("is pinned for every version up to the current one, which is the latest", () => {
    const versions = Object.keys(PINNED_SHAPES).map(Number);
    expect(versions).toEqual(Array.from({ length: versions.length }, (_, index) => index + 1));
    expect(versions.at(-1)).toBe(STORED_SHAPE_VERSION);
  });

  test("pins nothing that has no fixture", () => {
    const pinned = Object.keys(PINNED_SHAPES[STORED_SHAPE_VERSION] ?? {}).sort();
    expect(pinned).toEqual(fixtures.map(({ name }) => name).sort());
  });

  for (const { name, queryKey, data } of fixtures) {
    test(`of ${name} is the shape version ${STORED_SHAPE_VERSION} pinned`, () => {
      const current = fingerprint(storedQueryData(queryKey, data));
      const pinned = PINNED_SHAPES[STORED_SHAPE_VERSION]?.[name];
      if (pinned === undefined)
        throw new Error(
          `Version ${STORED_SHAPE_VERSION} pins no shape for "${name}". Add "${name}": "${current}" ` +
            `to its entry in PINNED_SHAPES (a new kind needs no version bump).`,
        );
      if (pinned !== current)
        throw new Error(
          `The stored shape of "${name}" changed: version ${STORED_SHAPE_VERSION} pinned ${pinned}, ` +
            `and it now stores ${current}. Rows written by version ${STORED_SHAPE_VERSION} can no ` +
            `longer be opened as they are, so raise STORED_SHAPE_VERSION in persisted-queries.ts to ` +
            `${STORED_SHAPE_VERSION + 1} and add that version to PINNED_SHAPES with every kind's ` +
            `shape (never edit an earlier version's entry).`,
        );
    });
  }
});
