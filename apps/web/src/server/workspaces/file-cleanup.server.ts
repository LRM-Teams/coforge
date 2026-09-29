import { ATTACHMENT_SESSION_SECONDS } from "#src/server/attachments/attachment.server";
import type { BulkFileRemoval } from "#src/server/files/file-storage.server";

/** The stored files a deleted Workspace leaves, by bucket. */
export type WorkspaceFileKeys = { files: readonly string[]; images: readonly string[] };

/** Runs `run` once, `afterMs` from now. */
export type CleanupSchedule = (run: () => Promise<void>, afterMs: number) => void;

/** A timer that never keeps the process alive; a restart before it fires skips the sweep. */
const timerSchedule: CleanupSchedule = (run, afterMs) => {
  setTimeout(() => void run(), afterMs).unref();
};

/** Long enough that every upload presigned before the delete has expired (plus a margin). */
const SWEEP_AFTER_MS = (ATTACHMENT_SESSION_SECONDS + 60) * 1000;

/**
 * Removes a deleted Workspace's stored files from the private and the public image bucket. Every
 * key it ever wrote starts with `workspaces/<id>/` in both. The keys its rows named go first in
 * bulk (`oss:DeleteObject` is enough), then everything under the prefix (`oss:ListObjects`).
 * The prefix is swept once more after the presigned upload lifetime, for an upload that lands
 * after the delete. Best effort: a failure is logged and never rejects, and a restart before
 * the second sweep leaves those late objects behind, unreferenced and never served.
 */
export class WorkspaceFileCleanup {
  constructor(
    private readonly buckets: {
      files: () => Promise<BulkFileRemoval>;
      images: () => Promise<BulkFileRemoval>;
    },
    private readonly schedule: CleanupSchedule = timerSchedule,
  ) {}

  async remove(workspaceId: string, keys: WorkspaceFileKeys): Promise<void> {
    this.schedule(() => this.#removeAll(workspaceId, { files: [], images: [] }), SWEEP_AFTER_MS);
    await this.#removeAll(workspaceId, keys);
  }

  async #removeAll(workspaceId: string, keys: WorkspaceFileKeys) {
    await Promise.all([
      this.#removeFrom("files", workspaceId, keys.files),
      this.#removeFrom("images", workspaceId, keys.images),
    ]);
  }

  async #removeFrom(bucket: "files" | "images", workspaceId: string, keys: readonly string[]) {
    let storage: BulkFileRemoval;
    try {
      storage = await this.buckets[bucket]();
    } catch (error) {
      logFailure(bucket, "open", workspaceId, error);
      return;
    }
    if (keys.length)
      await storage
        .removeMany(keys)
        .catch((error: unknown) => logFailure(bucket, "remove_many", workspaceId, error));
    await storage
      .removePrefix(`workspaces/${workspaceId}/`)
      .catch((error: unknown) => logFailure(bucket, "remove_prefix", workspaceId, error));
  }
}

function logFailure(bucket: string, step: string, workspaceId: string, error: unknown) {
  console.warn(
    JSON.stringify({
      event: "workspace_file_cleanup:failed",
      bucket,
      step,
      workspace_id: workspaceId,
      error_type: error instanceof Error ? error.name : typeof error,
      error_code:
        typeof error === "object" && error && "code" in error ? String(error.code) : undefined,
    }),
  );
}
