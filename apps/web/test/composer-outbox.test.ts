import { describe, expect, test } from "bun:test";

import {
  createComposerOutbox,
  draftWithUnsentMessage,
  outboxLocalIdOfStorageKey,
  unsentReason,
  unsentReasonAllowsRetry,
  type OutboxStorage,
  type OutgoingMessage,
} from "@/features/conversations/composer-outbox";
import { AppError } from "@/lib/app-error";

function memoryStorage(): OutboxStorage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

let counter = 0;
function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  counter += 1;
  return {
    localId: `local-${counter}`,
    draftKey: "chat-a",
    body: `message ${counter}`,
    requestId: `request-${counter}`,
    asTask: false,
    attachments: [],
    ...overrides,
  };
}

describe("createComposerOutbox", () => {
  test("a chat's sends go out in submit order: each starts once the one before it settled", async () => {
    const outbox = createComposerOutbox(memoryStorage());
    const first = gate();
    let firstSettled = false;
    let firstSettledWhenSecondStarted: boolean | undefined;
    const firstDone = outbox.send(message(), async () => {
      await first.promise;
      firstSettled = true;
    });
    const secondDone = outbox.send(message(), async () => {
      firstSettledWhenSecondStarted = firstSettled;
    });
    first.open();
    await Promise.all([firstDone, secondDone]);
    expect(firstSettledWhenSecondStarted).toBe(true);
  });

  test("a failed send stays listed as unsent with its reason and does not hold back the next one", async () => {
    const outbox = createComposerOutbox(memoryStorage());
    const failing = message();
    await outbox.send(failing, async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await outbox.send(message(), async () => "delivered");
    expect(result).toBe("delivered");
    expect(outbox.entries("chat-a")).toEqual([
      { ...failing, state: "unsent", reason: "offline", errorId: undefined },
    ]);
  });

  test("retrying an unsent message sends it again under the same request id and clears it", async () => {
    const outbox = createComposerOutbox(memoryStorage());
    const failing = message();
    await outbox.send(failing, async () => {
      throw new TypeError("Failed to fetch");
    });
    const requestIds: string[] = [];
    await outbox.retry(failing.localId, async (entry) => {
      requestIds.push(entry.requestId);
    });
    expect(requestIds).toEqual([failing.requestId]);
    expect(outbox.entries("chat-a")).toEqual([]);
  });

  test("unsent messages survive a reload, and one still in flight comes back as interrupted", async () => {
    const storage = memoryStorage();
    const before = createComposerOutbox(storage);
    const failing = message({ attachments: [{ id: "file-1", fileName: "plan.pdf" }] });
    await before.send(failing, async () => {
      throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "err-1" });
    });
    const inFlight = message();
    void before.send(inFlight, () => new Promise<never>(() => {}));

    const after = createComposerOutbox(storage);
    expect(after.entries("chat-a")).toEqual([
      { ...failing, state: "unsent", reason: "unavailable", errorId: "err-1" },
      { ...inFlight, state: "unsent", reason: "interrupted" },
    ]);
  });

  test("a delivered or discarded message leaves nothing behind on the device", async () => {
    const storage = memoryStorage();
    const outbox = createComposerOutbox(storage);
    await outbox.send(message(), async () => undefined);
    const failing = message();
    await outbox.send(failing, async () => {
      throw new TypeError("Failed to fetch");
    });
    outbox.discard(failing.localId);
    expect(storage.length).toBe(0);
    expect(createComposerOutbox(storage).entries("chat-a")).toEqual([]);
  });

  test("each chat sees only its own messages, as the same list until something changes", async () => {
    const outbox = createComposerOutbox(memoryStorage());
    await outbox.send(message({ draftKey: "chat-b" }), async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(outbox.entries("chat-a")).toEqual([]);
    const listed = outbox.entries("chat-b");
    expect(listed).toHaveLength(1);
    expect(outbox.entries("chat-b")).toBe(listed);
  });
  test("an attempt that fails after the message was discarded elsewhere does not bring it back", async () => {
    const storage = memoryStorage();
    const outbox = createComposerOutbox(storage);
    const sent = message();
    let failAttempt!: (cause: unknown) => void;
    let attemptStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      attemptStarted = resolve;
    });
    const done = outbox.send(
      sent,
      () =>
        new Promise((_, reject) => {
          failAttempt = reject;
          attemptStarted();
        }),
    );
    await started;
    outbox.discard(sent.localId);
    failAttempt(new TypeError("Failed to fetch"));
    await done;
    expect(outbox.entries("chat-a")).toEqual([]);
    expect(storage.length).toBe(0);
  });
});

describe("outboxLocalIdOfStorageKey", () => {
  test("names the message an outbox storage key holds, and nothing for other keys", async () => {
    const storage = memoryStorage();
    const failing = message();
    await createComposerOutbox(storage).send(failing, async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(outboxLocalIdOfStorageKey(storage.key(0))).toBe(failing.localId);
    expect(outboxLocalIdOfStorageKey("coforge.composer-draft:chat-a")).toBeUndefined();
    expect(outboxLocalIdOfStorageKey(null)).toBeUndefined();
  });
});

describe("unsentReason", () => {
  test("a request that never reached the server can be retried", () => {
    expect(unsentReason(new TypeError("Failed to fetch"))).toBe("offline");
    expect(unsentReason(new TypeError("Load failed"))).toBe("offline");
    expect(unsentReasonAllowsRetry("offline")).toBe(true);
    expect(unsentReason(new AppError("INTERNAL_ERROR"))).toBe("unavailable");
    expect(unsentReasonAllowsRetry("unavailable")).toBe(true);
    expect(unsentReasonAllowsRetry("interrupted")).toBe(true);
  });

  test("a failure that is not a lost connection is never reported as one", () => {
    expect(unsentReason(new TypeError("Cannot read properties of undefined"))).toBe("unavailable");
    expect(unsentReason(new Error("boom"))).toBe("unavailable");
  });

  test("a refusal that would repeat on retry is not offered a retry", () => {
    expect(unsentReason(new AppError("ACCESS_DENIED"))).toBe("denied");
    expect(unsentReason(new AppError("AGENT_DM_RESTRICTED"))).toBe("denied");
    expect(unsentReason(new AppError("NOT_FOUND"))).toBe("gone");
    expect(unsentReason(new AppError("INVALID_INPUT"))).toBe("rejected");
    for (const reason of ["denied", "gone", "rejected"] as const)
      expect(unsentReasonAllowsRetry(reason)).toBe(false);
  });
});

describe("draftWithUnsentMessage", () => {
  test("an empty composer gets the unsent text back as-is", () => {
    expect(draftWithUnsentMessage("", "hello")).toBe("hello");
    expect(draftWithUnsentMessage("  \n", "hello")).toBe("hello");
  });

  test("text typed since keeps its place after the unsent message", () => {
    expect(draftWithUnsentMessage("next thought", "hello")).toBe("hello\n\nnext thought");
  });
});
