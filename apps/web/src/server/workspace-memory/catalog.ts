/**
 * P4 port extension: listing and window-load queries the frozen P3 stores do not expose.
 */
import type { AdmittedSegmentDispatchRecord } from "./dispatch";
import type { AdmissionConversation, AdmissionMessage, AdmissionTask } from "./detect-segments";
import type { WorkspaceMemoryProfile } from "./profile";

export type AdmissionWindow = {
  conversations: AdmissionConversation[];
  messages: AdmissionMessage[];
  tasks: AdmissionTask[];
};

export type WorkspaceMemoryCatalog = {
  listKnownWorkspaceIds(): Promise<string[]>;
  listAdmittedMessageIds(workspaceId: string): Promise<Set<string>>;
  listRetryableDispatches(workspaceId: string): Promise<AdmittedSegmentDispatchRecord[]>;
  listMemoryOfferMessageIds(workspaceId: string): Promise<readonly string[]>;
  loadAdmissionWindow(workspaceId: string, after: Date | null): Promise<AdmissionWindow>;
  loadMessagesByIds(
    workspaceId: string,
    messageIds: readonly string[],
  ): Promise<AdmissionMessage[]>;
};

export type InMemoryWorkspaceMemoryCatalog = WorkspaceMemoryCatalog & {
  seedProfile(profile: WorkspaceMemoryProfile): void;
  seedConversation(conversation: AdmissionConversation): void;
  seedMessages(messages: readonly AdmissionMessage[]): void;
  seedTasks(tasks: readonly AdmissionTask[]): void;
  seedOfferMessageIds(workspaceId: string, messageIds: readonly string[]): void;
};

export function createInMemoryWorkspaceMemoryCatalog(deps: {
  listAdmittedMessageIds(workspaceId: string): Promise<Set<string>>;
  listRetryableDispatches(workspaceId: string): Promise<AdmittedSegmentDispatchRecord[]>;
}): InMemoryWorkspaceMemoryCatalog {
  const profiles = new Map<string, WorkspaceMemoryProfile>();
  const conversations: AdmissionConversation[] = [];
  const messages: AdmissionMessage[] = [];
  const tasks: AdmissionTask[] = [];
  const offerMessageIds = new Map<string, readonly string[]>();

  return {
    seedProfile(profile) {
      profiles.set(profile.workspaceId, profile);
    },
    seedConversation(conversation) {
      conversations.push(conversation);
    },
    seedMessages(rows) {
      messages.push(...rows);
    },
    seedTasks(rows) {
      tasks.push(...rows);
    },
    seedOfferMessageIds(workspaceId, messageIds) {
      offerMessageIds.set(workspaceId, [...messageIds]);
    },
    async listKnownWorkspaceIds() {
      return [...profiles.keys()];
    },
    listAdmittedMessageIds: deps.listAdmittedMessageIds,
    listRetryableDispatches: deps.listRetryableDispatches,
    async listMemoryOfferMessageIds(workspaceId) {
      return offerMessageIds.get(workspaceId) ?? [];
    },
    async loadAdmissionWindow(workspaceId, after) {
      const afterMs = after?.getTime() ?? Number.NEGATIVE_INFINITY;
      return {
        conversations: conversations.filter((row) => row.workspaceId === workspaceId),
        messages: messages.filter(
          (row) => row.workspaceId === workspaceId && row.createdAt.getTime() > afterMs,
        ),
        tasks: tasks.filter(
          (row) => row.workspaceId === workspaceId && row.updatedAt.getTime() > afterMs,
        ),
      };
    },
    async loadMessagesByIds(workspaceId, messageIds) {
      const wanted = new Set(messageIds);
      return messages.filter((row) => row.workspaceId === workspaceId && wanted.has(row.id));
    },
  };
}
