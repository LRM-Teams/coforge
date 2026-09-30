import { expect, test } from "bun:test";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";

import { mergeMessages } from "#src/features/conversations/conversation-messages";
import {
  mapBrowserMessage,
  type BrowserMessageRow,
} from "#src/server/conversations/conversation-history.server";

// A re-read of a conversation's window (a refetch on focus or remount, an invalidation, a
// reconcile) hands the Query cache freshly decoded messages. TanStack Query's structural sharing
// keeps every message whose content did not change as the object already cached, so its memoized
// row does not render again; that only works on JSON-compatible values.

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const QUERY_KEY = ["conversation", "channel", "channel-1"];

type Message = ReturnType<typeof mapBrowserMessage>;
type Page = { conversationId: string; hasOlder: boolean; messages: Message[] };

function row(sequence: number, overrides: Partial<BrowserMessageRow> = {}): BrowserMessageRow {
  return {
    id: `message-${sequence}`,
    sequence,
    threadRootId: null,
    senderMemberId: "member-1",
    body: `message ${sequence}`,
    createdAt: new Date(`2026-09-17T10:0${sequence}:00Z`),
    sender: null,
    attachments: [],
    mentions: [],
    reactions: [],
    ...overrides,
  };
}

/** What the server function returns for these rows: a fresh projection of freshly read rows (a
 * database read builds new `Date`s) every time. */
function read(rows: BrowserMessageRow[]): InfiniteData<Page, unknown> {
  return {
    pages: [
      {
        conversationId: "channel-1",
        hasOlder: false,
        messages: rows.map((message) =>
          mapBrowserMessage({ ...message, createdAt: new Date(message.createdAt) }, WORKSPACE_ID),
        ),
      },
    ],
    pageParams: [undefined],
  };
}

const messagesOf = (client: QueryClient) =>
  client.getQueryData<InfiniteData<Page, unknown>>(QUERY_KEY)!.pages[0]!.messages;

test("re-reading an unchanged window keeps every cached message object", () => {
  const client = new QueryClient();
  const rows = [row(1), row(2), row(3)];
  client.setQueryData(QUERY_KEY, read(rows));
  const before = messagesOf(client);

  client.setQueryData(QUERY_KEY, read(rows));

  const after = messagesOf(client);
  after.forEach((message, index) => expect(message).toBe(before[index]!));
});

test("a re-read gives a new object only to the message that changed", () => {
  const client = new QueryClient();
  client.setQueryData(QUERY_KEY, read([row(1), row(2), row(3)]));
  const before = messagesOf(client);

  client.setQueryData(
    QUERY_KEY,
    read([
      row(1),
      row(2, {
        reactions: [
          {
            emoji: "👍",
            member: {
              userId: "user-ada",
              agentId: null,
              agent: null,
              user: { username: "ada", displayName: null, fullName: null },
            },
          },
        ],
      }),
      row(3),
    ]),
  );

  const after = messagesOf(client);
  expect(after[0]).toBe(before[0]!);
  expect(after[1]).not.toBe(before[1]!);
  expect(after[2]).toBe(before[2]!);
});

test("a reconcile that returns an already loaded message keeps its object", () => {
  const client = new QueryClient();
  const rows = [row(1), row(2), row(3)];
  client.setQueryData(QUERY_KEY, read(rows));
  const before = messagesOf(client);

  // What `mergeUpdates` writes: the loaded page with the reconciled messages folded in by id.
  const updates = read([rows[2]!]).pages[0]!.messages;
  client.setQueryData<InfiniteData<Page, unknown>>(QUERY_KEY, (window) => ({
    ...window!,
    pages: [{ ...window!.pages[0]!, messages: mergeMessages(window!.pages[0]!.messages, updates) }],
  }));

  expect(messagesOf(client)[2]).toBe(before[2]!);
});
