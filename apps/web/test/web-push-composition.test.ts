import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { PrismaClient } from "../generated/client";
import { bestEffortMessageNotifier } from "../src/server/notifications/web-push-composition.server";

const db = {} as PrismaClient;

describe("bestEffortMessageNotifier", () => {
  test("resolves promptly even when delivery never settles", async () => {
    const notifier = bestEffortMessageNotifier(db, async () => ({
      notifyMessage: () => new Promise(() => {}),
    }));

    await expect(notifier.notifyMessage("message-a")).resolves.toBeUndefined();
  });

  describe("when background delivery fails", () => {
    let warn: ReturnType<typeof spyOn<Console, "warn">>;

    beforeEach(() => {
      warn = spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warn.mockRestore();
    });

    test("still resolves and logs web_push.unavailable in the background", async () => {
      let releaseFailure!: (error: Error) => void;
      const failure = new Promise<never>((_resolve, reject) => {
        releaseFailure = reject;
      });
      let warned!: () => void;
      const warnedOnce = new Promise<void>((resolve) => {
        warned = resolve;
      });
      warn.mockImplementation(() => {
        warned();
      });

      const notifier = bestEffortMessageNotifier(db, async () => ({
        notifyMessage: () => failure,
      }));

      await expect(notifier.notifyMessage("message-a")).resolves.toBeUndefined();

      releaseFailure(new Error("delivery unavailable"));
      await warnedOnce;

      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({ event: "web_push.unavailable", messageId: "message-a" }),
      );
    });
  });
});
