import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { subscribeToConversationRealtime } from "#src/features/conversations/conversation-realtime-client";

type PublicationListener = (context: { data: unknown }) => void;
type SubscribedListener = (context: { wasRecovering: boolean; recovered: boolean }) => void;

function fakeClient() {
  const publications: PublicationListener[] = [];
  const subscribedListeners: SubscribedListener[] = [];
  const subscription = {
    on(event: string, listener: PublicationListener | SubscribedListener) {
      if (event === "publication") publications.push(listener as PublicationListener);
      if (event === "subscribed") subscribedListeners.push(listener as SubscribedListener);
      return subscription;
    },
    subscribe() {},
    unsubscribe() {},
  };
  return {
    client: {
      newSubscription: () => subscription,
      removeSubscription() {},
    },
    publish(data: unknown) {
      for (const listener of publications) listener({ data });
    },
    subscribed(context: { wasRecovering: boolean; recovered: boolean }) {
      for (const listener of subscribedListeners) listener(context);
    },
  };
}

const originals = { document: globalThis.document, window: globalThis.window };

beforeEach(() => {
  const target = { addEventListener() {}, removeEventListener() {} };
  Object.assign(globalThis, {
    document: { ...target, visibilityState: "visible" },
    window: { ...target, setInterval: () => 0, clearInterval() {} },
  });
});

afterEach(() => {
  Object.assign(globalThis, originals);
});

describe("subscribeToConversationRealtime", () => {
  test("hands the sender's request id to the page along with the message it became", () => {
    const { client, publish } = fakeClient();
    const sent: [string, string][] = [];
    let reconciled = 0;
    subscribeToConversationRealtime(client, {
      conversationId: "conversation-a",
      getToken: async () => "token",
      reconcile: () => {
        reconciled += 1;
      },
      onSentMessage: (requestId, messageId) => sent.push([requestId, messageId]),
    });

    publish({
      type: "message.available.v1",
      conversationId: "conversation-a",
      messageId: "message-a",
      sequence: 3,
      requestId: "request-a",
    });
    publish({
      type: "message.available.v1",
      conversationId: "conversation-a",
      messageId: "message-b",
      sequence: 4,
    });

    expect(sent).toEqual([["request-a", "message-a"]]);
    expect(reconciled).toBe(2);
  });

  test("a member change refreshes this conversation's member list, not its messages", () => {
    const { client, publish } = fakeClient();
    let memberChanges = 0;
    let reconciled = 0;
    subscribeToConversationRealtime(client, {
      conversationId: "conversation-a",
      getToken: async () => "token",
      reconcile: () => {
        reconciled += 1;
      },
      onMemberChanged: () => {
        memberChanges += 1;
      },
    });

    publish({ type: "member.changed.v1", conversationId: "conversation-a", workspaceId: "w" });
    publish({ type: "member.changed.v1", conversationId: "conversation-b", workspaceId: "w" });

    expect(memberChanges).toBe(1);
    expect(reconciled).toBe(0);
  });

  test("a rename or archive of this channel refreshes the open page, not its messages", () => {
    const { client, publish } = fakeClient();
    let channelUpdates = 0;
    let reconciled = 0;
    subscribeToConversationRealtime(client, {
      conversationId: "conversation-a",
      getToken: async () => "token",
      reconcile: () => {
        reconciled += 1;
      },
      onChannelUpdated: () => {
        channelUpdates += 1;
      },
    });

    publish({ type: "channel.updated.v1", conversationId: "conversation-a", workspaceId: "w" });
    publish({ type: "channel.updated.v1", conversationId: "conversation-b", workspaceId: "w" });

    expect(channelUpdates).toBe(1);
    expect(reconciled).toBe(0);
  });

  test("a subscribe that could not replay publications refreshes the member list as well as messages", () => {
    const { client, subscribed } = fakeClient();
    let memberChanges = 0;
    subscribeToConversationRealtime(client, {
      conversationId: "conversation-a",
      getToken: async () => "token",
      reconcile: () => {},
      onMemberChanged: () => {
        memberChanges += 1;
      },
    });

    // A recovered resubscribe replays every missed publication, so it needs no refetch.
    subscribed({ wasRecovering: true, recovered: true });
    expect(memberChanges).toBe(0);

    // The first subscribe cannot replay a change made while the page was loading its list.
    subscribed({ wasRecovering: false, recovered: false });
    subscribed({ wasRecovering: true, recovered: false });
    expect(memberChanges).toBe(2);
  });
});
