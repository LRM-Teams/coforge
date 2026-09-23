import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { subscribeToConversationRealtime } from "../src/features/conversations/conversation-realtime-client";

type PublicationListener = (context: { data: unknown }) => void;
type SubscribedListener = (context: { wasRecovering: boolean; recovered: boolean }) => void;

function fakeClient() {
  const publications: (PublicationListener | SubscribedListener)[] = [];
  const subscription = {
    on(event: string, listener: PublicationListener | SubscribedListener) {
      if (event === "publication") publications.push(listener);
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
      for (const listener of publications)
        listener({ data, wasRecovering: false, recovered: false });
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
});
