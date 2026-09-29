import { expect, test } from "bun:test";

import { ATTACHMENT_SESSION_SECONDS } from "#src/server/attachments/attachment.server";
import type { BulkFileRemoval } from "#src/server/files/file-storage.server";
import { WorkspaceFileCleanup } from "#src/server/workspaces/file-cleanup.server";

/** A bucket that records the bulk removals asked of it, and can refuse one kind of them. */
function recordingBucket(refuse?: "removeMany" | "removePrefix") {
  const calls: string[] = [];
  const bucket: BulkFileRemoval = {
    async removeMany(keys) {
      calls.push(`many:${keys.join(",")}`);
      if (refuse === "removeMany") throw new Error("AccessDenied");
    },
    async removePrefix(prefix) {
      calls.push(`prefix:${prefix}`);
      if (refuse === "removePrefix") throw new Error("AccessDenied");
    },
  };
  return { calls, bucket: async () => bucket };
}

function manualSchedule() {
  const scheduled: { run: () => Promise<void>; afterMs: number }[] = [];
  return {
    scheduled,
    schedule: (run: () => Promise<void>, afterMs: number) => {
      scheduled.push({ run, afterMs });
    },
  };
}

test("removes the Workspace's known files in bulk, then everything under its prefix, in both buckets", async () => {
  const files = recordingBucket();
  const images = recordingBucket();
  const timer = manualSchedule();
  await new WorkspaceFileCleanup(
    { files: files.bucket, images: images.bucket },
    timer.schedule,
  ).remove("ws-1", { files: ["workspaces/ws-1/attachments/a/original"], images: [] });

  expect(files.calls).toEqual([
    "many:workspaces/ws-1/attachments/a/original",
    "prefix:workspaces/ws-1/",
  ]);
  // No known image keys: nothing to remove by key, the prefix still goes.
  expect(images.calls).toEqual(["prefix:workspaces/ws-1/"]);
});

test("sweeps the prefix again once every upload presigned before the delete has expired", async () => {
  const files = recordingBucket();
  const images = recordingBucket();
  const timer = manualSchedule();
  await new WorkspaceFileCleanup(
    { files: files.bucket, images: images.bucket },
    timer.schedule,
  ).remove("ws-1", { files: [], images: ["workspaces/ws-1/icons/i/original"] });

  expect(timer.scheduled).toHaveLength(1);
  expect(timer.scheduled[0]!.afterMs).toBeGreaterThan(ATTACHMENT_SESSION_SECONDS * 1000);
  files.calls.length = 0;
  images.calls.length = 0;
  await timer.scheduled[0]!.run();
  expect(files.calls).toEqual(["prefix:workspaces/ws-1/"]);
  expect(images.calls).toEqual(["prefix:workspaces/ws-1/"]);
});

test("a bucket that refuses one removal still gets the other, and the cleanup never rejects", async () => {
  // A bucket without `oss:ListObjects` refuses the prefix; the known keys still go.
  const files = recordingBucket("removePrefix");
  const images = recordingBucket("removeMany");
  const timer = manualSchedule();
  await new WorkspaceFileCleanup(
    {
      files: files.bucket,
      images: async () => {
        throw new Error("storage unconfigured");
      },
    },
    timer.schedule,
  ).remove("ws-1", { files: ["k1"], images: ["k2"] });
  expect(files.calls).toEqual(["many:k1", "prefix:workspaces/ws-1/"]);
  expect(images.calls).toEqual([]);
  expect(timer.scheduled).toHaveLength(1);
});
