/**
 * P4 port extension: common admission sweep. Framework-free; timers/Redis live in lifecycle.
 */
import type { WorkspaceMemoryCatalog } from "./catalog";
import {
  detectAdmittedPublicChannelSegments,
  sourcePayloadHash,
  type AdmissionTurn,
  type DetectedPublicChannelSegment,
} from "./detect-segments";
import type { AdmissionDispatcher, WorkspaceMemoryAdmissionPort } from "./dispatch";
import type { WorkspaceMemoryProfileReconciler } from "./reconciler";
import type { WorkspaceMemoryProfileStore } from "./stores";

export const WORKSPACE_MEMORY_QUIET_WINDOW_MS = 15 * 60 * 1000;

export type WorkspaceMemorySweepLock = {
  acquire(instanceId: string): Promise<boolean>;
};

export type WorkspaceMemoryAdmissionSweep = {
  tick(): Promise<void>;
};

export function createWorkspaceMemoryAdmissionSweep(deps: {
  profiles: WorkspaceMemoryProfileStore;
  catalog: WorkspaceMemoryCatalog;
  admission: Pick<WorkspaceMemoryAdmissionPort, "getSegment">;
  dispatcher: AdmissionDispatcher;
  reconciler: WorkspaceMemoryProfileReconciler;
  lock: WorkspaceMemorySweepLock;
  now?: () => Date;
  quietAfterMs?: number;
  instanceId?: string;
  onError?: (event: string, extra: Record<string, unknown>) => void;
}): WorkspaceMemoryAdmissionSweep {
  const now = deps.now ?? (() => new Date());
  const quietAfterMs = deps.quietAfterMs ?? WORKSPACE_MEMORY_QUIET_WINDOW_MS;
  const instanceId = deps.instanceId ?? crypto.randomUUID();
  const onError =
    deps.onError ??
    ((event, extra) => {
      console.error(JSON.stringify({ event, ...extra }));
    });
  let ticking = false;

  return {
    async tick() {
      if (ticking) return;
      ticking = true;
      try {
        if (!(await deps.lock.acquire(instanceId))) return;
        const workspaceIds = await deps.catalog.listKnownWorkspaceIds();
        for (const workspaceId of workspaceIds) {
          try {
            await deps.reconciler.reconcile(workspaceId);
          } catch (error) {
            onError("workspace_memory_sweep.reconcile_failed", {
              workspaceId,
              error: error instanceof Error ? error.message : "unknown",
            });
          }
        }
        for (const workspaceId of workspaceIds) {
          try {
            await admitWorkspace(workspaceId);
          } catch (error) {
            onError("workspace_memory_sweep.workspace_failed", {
              workspaceId,
              error: error instanceof Error ? error.message : "unknown",
            });
          }
        }
      } catch (error) {
        onError("workspace_memory_sweep.tick_failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
      } finally {
        ticking = false;
      }
    },
  };

  async function admitWorkspace(workspaceId: string): Promise<void> {
    const profile = await deps.profiles.get(workspaceId);
    if (!profile) return;
    const after = profile.activationCursor ? new Date(profile.activationCursor.occurredAt) : null;
    const window = await deps.catalog.loadAdmissionWindow(workspaceId, after);
    const detected = detectAdmittedPublicChannelSegments({
      ...window,
      admittedMessageIds: await deps.catalog.listAdmittedMessageIds(workspaceId),
      now: now(),
      quietAfterMs,
    });
    for (const segment of detected) {
      await deps.dispatcher.dispatch({ profile, detected: segment });
    }
    for (const record of await deps.catalog.listRetryableDispatches(workspaceId)) {
      if (detected.some((segment) => segment.segmentId === record.segmentId)) continue;
      const stored = await deps.admission.getSegment(workspaceId, record.segmentId);
      if (!stored) continue;
      const messages = await deps.catalog.loadMessagesByIds(workspaceId, stored.sourceMessageIds);
      if (messages.length === 0) continue;
      await deps.dispatcher.dispatch({
        profile,
        detected: toDetected(stored, messages),
        admitted: stored,
        sinkProfile: record.sinkProfile,
      });
    }
  }
}

function toDetected(
  stored: {
    segmentId: string;
    sourceMessageIds: readonly string[];
    workspace: { workspaceId: string; channelId: string };
    kind: DetectedPublicChannelSegment["kind"];
    conversationKind: "public_channel";
    sourcePayloadHash: string;
    closedAt: string;
  },
  messages: readonly {
    id: string;
    sequence: number;
    createdAt: Date;
    body: string;
    senderKind: AdmissionTurn["senderKind"];
    senderHandle: string;
  }[],
): DetectedPublicChannelSegment {
  const byId = new Map(messages.map((message) => [message.id, message]));
  return {
    segmentId: stored.segmentId,
    sourceMessageIds: stored.sourceMessageIds,
    workspace: stored.workspace,
    kind: stored.kind,
    conversationKind: stored.conversationKind,
    sourcePayloadHash: stored.sourcePayloadHash,
    closedAt: stored.closedAt,
    turns: stored.sourceMessageIds.flatMap((messageId) => {
      const message = byId.get(messageId);
      if (!message) return [];
      return [
        {
          messageId: message.id,
          sequence: message.sequence,
          occurredAt: message.createdAt.toISOString(),
          payloadHash: sourcePayloadHash([message]),
          senderKind: message.senderKind,
          senderHandle: message.senderHandle,
          body: message.body,
        },
      ];
    }),
  };
}
