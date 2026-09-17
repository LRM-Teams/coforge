import { agentApiRoutes, workspaceInfoRoute } from "./routes";
import type {
  AgentReminderRequest,
  AgentReminderResponse,
  AgentTaskRequest,
  AgentTaskResponse,
} from "./types";
import type {
  AgentMessagesReadRequest,
  AgentMessagesSearchRequest,
  AgentMessagesSendRequest,
  AgentMessagesResolveRequest,
  AgentMessagesReactionRequest,
  AgentHistoryResponse,
  AgentSearchResponse,
  AgentSendResponse,
  AgentResolveResponse,
  AgentReactionResponse,
  AgentEventsGetRequest,
  AgentEventsResponse,
  AgentChannelAttentionResponse,
  AgentThreadAttentionResponse,
} from "./messages";

export type AgentAttachmentDownload = {
  bytes: Uint8Array;
  fileName?: string;
  contentType?: string;
};

export type AgentAttachmentUploadResponse = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};

/**
 * Presigned direct-upload sessions (ADR 0027), mirroring Raft 1.0.32's
 * `attachment-upload-sessions` state machine. `create`'s request field is `target` (this
 * repo's `#channel`/`@user` grammar), not Raft's resolved `channelId`.
 */
export type AgentAttachmentUploadSessionState =
  | "pending"
  | "verifying"
  | "completed"
  | "canceled"
  | "expired"
  | "failed";

export type AgentAttachmentUploadSessionAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};

export type AgentAttachmentUploadSessionCreateRequest = {
  target: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  clientRequestId: string;
};

export type AgentAttachmentUploadSessionCreateResponse = {
  uploadId: string;
  attachmentId: string;
  state: "pending";
  expiresAt: string;
  upload: { method: "PUT"; url: string; headers: Record<string, string> };
};

export type AgentAttachmentUploadSessionCompleteResponse = {
  uploadId: string;
  state: "completed";
  attachment: AgentAttachmentUploadSessionAttachment;
};

export type AgentAttachmentUploadSessionView = {
  uploadId: string;
  state: AgentAttachmentUploadSessionState;
  expiresAt: string;
  attachment: AgentAttachmentUploadSessionAttachment | null;
  terminalReason: string | null;
};

export type GitHubCredentialRequest = Record<string, never>;
export type GitHubCredentialResponse = {
  username: "x-access-token";
  password: string;
  expiresAt: string;
};

export function decodeGitHubCredentialResponse(value: unknown): GitHubCredentialResponse {
  if (
    !value ||
    typeof value !== "object" ||
    !("username" in value) ||
    value.username !== "x-access-token" ||
    !("password" in value) ||
    typeof value.password !== "string" ||
    value.password.length === 0 ||
    !("expiresAt" in value) ||
    typeof value.expiresAt !== "string" ||
    Number.isNaN(Date.parse(value.expiresAt))
  ) {
    throw new Error("invalid GitHub credential response");
  }
  return {
    username: value.username,
    password: value.password,
    expiresAt: value.expiresAt,
  };
}

export { agentApiRoutes, workspaceInfoRoute } from "./routes";

export type WorkspaceInfoHuman = { id: string; name: string; displayName: string; role: string };
export type WorkspaceInfoAgent = WorkspaceInfoHuman & {
  status: string;
  activity: string;
  activityDetail: string;
  runtime: string;
  model: string;
  computerName: string;
  daemonVersion: string;
};
export type WorkspaceInfoProject = {
  id: string;
  name: string;
  slug: string;
  githubFullName: string;
  githubHtmlUrl: string;
};
export type WorkspaceInfoResult = {
  protocolMajor: number;
  requestId: string;
  workspace: { id: string; slug: string; name: string };
  humans: WorkspaceInfoHuman[];
  agents: WorkspaceInfoAgent[];
  projects: WorkspaceInfoProject[];
};

export type MessageTransport = {
  workspaceInfo?(): Promise<WorkspaceInfoResult>;
};

export type AgentApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

export type AgentApiClient = {
  workspace: {
    info(): Promise<WorkspaceInfoResult>;
  };
  tasks: {
    list(request: AgentTaskInput): Promise<AgentTaskResponse>;
    create(request: AgentTaskInput): Promise<AgentTaskResponse>;
    convert(request: AgentTaskInput): Promise<AgentTaskResponse>;
    claim(request: AgentTaskInput): Promise<AgentTaskResponse>;
    unclaim(request: AgentTaskInput): Promise<AgentTaskResponse>;
    update(request: AgentTaskInput): Promise<AgentTaskResponse>;
  };
  reminders: {
    schedule(request: AgentReminderInput): Promise<AgentReminderResponse>;
    list(request: AgentReminderInput): Promise<AgentReminderResponse>;
    update(request: AgentReminderInput): Promise<AgentReminderResponse>;
    snooze(request: AgentReminderInput): Promise<AgentReminderResponse>;
    cancel(request: AgentReminderInput): Promise<AgentReminderResponse>;
    log(request: AgentReminderInput): Promise<AgentReminderResponse>;
  };
  messages: {
    read(request: AgentMessagesReadRequest): Promise<AgentHistoryResponse>;
    search(request: AgentMessagesSearchRequest): Promise<AgentSearchResponse>;
    send(request: AgentMessagesSendRequest): Promise<AgentSendResponse>;
    resolve(request: AgentMessagesResolveRequest): Promise<AgentResolveResponse>;
    addReaction(request: AgentMessagesReactionRequest): Promise<AgentReactionResponse>;
    removeReaction(request: AgentMessagesReactionRequest): Promise<AgentReactionResponse>;
  };
  events: { get(request: AgentEventsGetRequest): Promise<AgentEventsResponse> };
  channels: {
    mute(channelId: string): Promise<AgentChannelAttentionResponse>;
    unmute(channelId: string): Promise<AgentChannelAttentionResponse>;
  };
  threads: { unfollow(threadId: string): Promise<AgentThreadAttentionResponse> };
  attachments: {
    download(attachmentId: string): Promise<AgentAttachmentDownload>;
    upload(form: FormData): Promise<AgentAttachmentUploadResponse>;
    uploadSessions: {
      create(
        request: AgentAttachmentUploadSessionCreateRequest,
      ): Promise<AgentAttachmentUploadSessionCreateResponse>;
      complete(uploadId: string): Promise<AgentAttachmentUploadSessionCompleteResponse>;
      cancel(uploadId: string): Promise<AgentAttachmentUploadSessionView>;
      get(uploadId: string): Promise<AgentAttachmentUploadSessionView>;
    };
  };
};

export type AgentApiTransport = {
  request(route: unknown, input?: unknown): Promise<AgentApiResult<unknown>>;
};

export type RawAgentApiClient = {
  workspace: {
    info(): Promise<AgentApiResult<WorkspaceInfoResult>>;
  };
  tasks: {
    list(request: AgentTaskInput): Promise<AgentApiResult<AgentTaskResponse>>;
    create(request: AgentTaskInput): Promise<AgentApiResult<AgentTaskResponse>>;
    convert(request: AgentTaskInput): Promise<AgentApiResult<AgentTaskResponse>>;
    claim(request: AgentTaskInput): Promise<AgentApiResult<AgentTaskResponse>>;
    unclaim(request: AgentTaskInput): Promise<AgentApiResult<AgentTaskResponse>>;
    update(request: AgentTaskInput): Promise<AgentApiResult<AgentTaskResponse>>;
  };
  reminders: {
    schedule(request: AgentReminderInput): Promise<AgentApiResult<AgentReminderResponse>>;
    list(request: AgentReminderInput): Promise<AgentApiResult<AgentReminderResponse>>;
    update(request: AgentReminderInput): Promise<AgentApiResult<AgentReminderResponse>>;
    snooze(request: AgentReminderInput): Promise<AgentApiResult<AgentReminderResponse>>;
    cancel(request: AgentReminderInput): Promise<AgentApiResult<AgentReminderResponse>>;
    log(request: AgentReminderInput): Promise<AgentApiResult<AgentReminderResponse>>;
  };
  messages: {
    read(request: AgentMessagesReadRequest): Promise<AgentApiResult<AgentHistoryResponse>>;
    search(request: AgentMessagesSearchRequest): Promise<AgentApiResult<AgentSearchResponse>>;
    send(request: AgentMessagesSendRequest): Promise<AgentApiResult<AgentSendResponse>>;
    resolve(request: AgentMessagesResolveRequest): Promise<AgentApiResult<AgentResolveResponse>>;
    addReaction(
      request: AgentMessagesReactionRequest,
    ): Promise<AgentApiResult<AgentReactionResponse>>;
    removeReaction(
      request: AgentMessagesReactionRequest,
    ): Promise<AgentApiResult<AgentReactionResponse>>;
  };
  events: { get(request: AgentEventsGetRequest): Promise<AgentApiResult<AgentEventsResponse>> };
  channels: {
    mute(channelId: string): Promise<AgentApiResult<AgentChannelAttentionResponse>>;
    unmute(channelId: string): Promise<AgentApiResult<AgentChannelAttentionResponse>>;
  };
  threads: { unfollow(threadId: string): Promise<AgentApiResult<AgentThreadAttentionResponse>> };
  attachments: {
    download(attachmentId: string): Promise<AgentApiResult<AgentAttachmentDownload>>;
    upload(form: FormData): Promise<AgentApiResult<AgentAttachmentUploadResponse>>;
    uploadSessions: {
      create(
        request: AgentAttachmentUploadSessionCreateRequest,
      ): Promise<AgentApiResult<AgentAttachmentUploadSessionCreateResponse>>;
      complete(
        uploadId: string,
      ): Promise<AgentApiResult<AgentAttachmentUploadSessionCompleteResponse>>;
      cancel(uploadId: string): Promise<AgentApiResult<AgentAttachmentUploadSessionView>>;
      get(uploadId: string): Promise<AgentApiResult<AgentAttachmentUploadSessionView>>;
    };
  };
};

export function createAgentApiRawClient(transport: AgentApiTransport): RawAgentApiClient {
  return {
    workspace: {
      info: () =>
        transport.request(workspaceInfoRoute) as Promise<AgentApiResult<WorkspaceInfoResult>>,
    },
    tasks: taskResources(transport),
    reminders: reminderResources(transport),
    messages: messageResources(transport),
    events: eventsResources(transport),
    channels: {
      mute: (channelId) =>
        transport.request(agentApiRoutes.cloud.channels.mute.path(channelId)) as Promise<
          AgentApiResult<AgentChannelAttentionResponse>
        >,
      unmute: (channelId) =>
        transport.request(agentApiRoutes.cloud.channels.unmute.path(channelId)) as Promise<
          AgentApiResult<AgentChannelAttentionResponse>
        >,
    },
    threads: {
      unfollow: (threadId) =>
        transport.request(agentApiRoutes.cloud.threads.unfollow.path(threadId)) as Promise<
          AgentApiResult<AgentThreadAttentionResponse>
        >,
    },
    attachments: {
      download: (attachmentId) =>
        transport.request(agentApiRoutes.cloud.attachments.path(attachmentId)) as Promise<
          AgentApiResult<AgentAttachmentDownload>
        >,
      upload: (form) =>
        transport.request(agentApiRoutes.cloud.attachments.upload, form) as Promise<
          AgentApiResult<AgentAttachmentUploadResponse>
        >,
      uploadSessions: {
        create: (request) =>
          transport.request(
            agentApiRoutes.cloud.attachmentUploadSessions.create,
            request,
          ) as Promise<AgentApiResult<AgentAttachmentUploadSessionCreateResponse>>,
        complete: (uploadId) =>
          transport.request(
            agentApiRoutes.cloud.attachmentUploadSessions.complete.path(uploadId),
          ) as Promise<AgentApiResult<AgentAttachmentUploadSessionCompleteResponse>>,
        cancel: (uploadId) =>
          transport.request(
            agentApiRoutes.cloud.attachmentUploadSessions.cancel.path(uploadId),
          ) as Promise<AgentApiResult<AgentAttachmentUploadSessionView>>,
        get: (uploadId) =>
          transport.request(
            agentApiRoutes.cloud.attachmentUploadSessions.get.path(uploadId),
          ) as Promise<AgentApiResult<AgentAttachmentUploadSessionView>>,
      },
    },
  };
}

export function createAgentApiClient(transport: AgentApiTransport): AgentApiClient {
  const rawClient = createAgentApiRawClient(transport);
  return {
    workspace: {
      info: async () => {
        const result = await rawClient.workspace.info();
        if (!result.ok) throw new Error(result.error);
        return result.data;
      },
    },
    tasks: {
      list: async (request) => unwrap(await rawClient.tasks.list(request)),
      create: async (request) => unwrap(await rawClient.tasks.create(request)),
      convert: async (request) => unwrap(await rawClient.tasks.convert(request)),
      claim: async (request) => unwrap(await rawClient.tasks.claim(request)),
      unclaim: async (request) => unwrap(await rawClient.tasks.unclaim(request)),
      update: async (request) => unwrap(await rawClient.tasks.update(request)),
    },
    reminders: {
      schedule: async (request) => unwrap(await rawClient.reminders.schedule(request)),
      list: async (request) => unwrap(await rawClient.reminders.list(request)),
      update: async (request) => unwrap(await rawClient.reminders.update(request)),
      snooze: async (request) => unwrap(await rawClient.reminders.snooze(request)),
      cancel: async (request) => unwrap(await rawClient.reminders.cancel(request)),
      log: async (request) => unwrap(await rawClient.reminders.log(request)),
    },
    messages: {
      read: async (request) => unwrap(await rawClient.messages.read(request)),
      search: async (request) => unwrap(await rawClient.messages.search(request)),
      send: async (request) => unwrap(await rawClient.messages.send(request)),
      resolve: async (request) => unwrap(await rawClient.messages.resolve(request)),
      addReaction: async (request) => unwrap(await rawClient.messages.addReaction(request)),
      removeReaction: async (request) => unwrap(await rawClient.messages.removeReaction(request)),
    },
    events: {
      get: async (request) => unwrap(await rawClient.events.get(request)),
    },
    channels: {
      mute: async (channelId) => unwrap(await rawClient.channels.mute(channelId)),
      unmute: async (channelId) => unwrap(await rawClient.channels.unmute(channelId)),
    },
    threads: {
      unfollow: async (threadId) => unwrap(await rawClient.threads.unfollow(threadId)),
    },
    attachments: {
      download: async (attachmentId) => unwrap(await rawClient.attachments.download(attachmentId)),
      upload: async (form) => unwrap(await rawClient.attachments.upload(form)),
      uploadSessions: {
        create: async (request) =>
          unwrap(await rawClient.attachments.uploadSessions.create(request)),
        complete: async (uploadId) =>
          unwrap(await rawClient.attachments.uploadSessions.complete(uploadId)),
        cancel: async (uploadId) =>
          unwrap(await rawClient.attachments.uploadSessions.cancel(uploadId)),
        get: async (uploadId) => unwrap(await rawClient.attachments.uploadSessions.get(uploadId)),
      },
    },
  };
}

function unwrap<T>(result: AgentApiResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

export type AgentTaskInput = Omit<AgentTaskRequest, "operation">;
export type AgentReminderInput = Omit<AgentReminderRequest, "operation">;

function taskResources(transport: AgentApiTransport): RawAgentApiClient["tasks"] {
  const execute = (operation: AgentTaskRequest["operation"]) => (request: AgentTaskInput) =>
    transport.request(agentApiRoutes.cloud.tasks, { ...request, operation }) as Promise<
      AgentApiResult<AgentTaskResponse>
    >;
  return {
    list: execute("list"),
    create: execute("create"),
    convert: execute("convert"),
    claim: execute("claim"),
    unclaim: execute("unclaim"),
    update: execute("update"),
  };
}

function reminderResources(transport: AgentApiTransport): RawAgentApiClient["reminders"] {
  const execute = (operation: AgentReminderRequest["operation"]) => (request: AgentReminderInput) =>
    transport.request(agentApiRoutes.cloud.reminders, {
      ...request,
      operation,
    }) as Promise<AgentApiResult<AgentReminderResponse>>;
  return {
    schedule: execute("schedule"),
    list: execute("list"),
    update: execute("update"),
    snooze: execute("snooze"),
    cancel: execute("cancel"),
    log: execute("log"),
  };
}

function messageResources(transport: AgentApiTransport): RawAgentApiClient["messages"] {
  return {
    read: (request) =>
      transport.request(agentApiRoutes.cloud.messages.list, request) as Promise<
        AgentApiResult<AgentHistoryResponse>
      >,
    search: (request) =>
      transport.request(agentApiRoutes.cloud.messages.search, request) as Promise<
        AgentApiResult<AgentSearchResponse>
      >,
    send: (request) =>
      transport.request(agentApiRoutes.cloud.messages.send, request) as Promise<
        AgentApiResult<AgentSendResponse>
      >,
    resolve: ({ messageId }) =>
      transport.request(agentApiRoutes.cloud.messages.resolve.path(messageId)) as Promise<
        AgentApiResult<AgentResolveResponse>
      >,
    addReaction: ({ messageId, emoji }) =>
      transport.request(agentApiRoutes.cloud.messages.reactions.path(messageId), {
        emoji,
      }) as Promise<AgentApiResult<AgentReactionResponse>>,
    removeReaction: ({ messageId, emoji }) =>
      transport.request(agentApiRoutes.cloud.messages.reactions.path(messageId), {
        emoji,
      }) as Promise<AgentApiResult<AgentReactionResponse>>,
  };
}

function eventsResources(transport: AgentApiTransport): RawAgentApiClient["events"] {
  return {
    get: (request) =>
      transport.request(agentApiRoutes.cloud.events, request) as Promise<
        AgentApiResult<AgentEventsResponse>
      >,
  };
}

export function createAgentApiSurfaceClient(transport: AgentApiTransport): AgentApiClient {
  return createAgentApiClient(transport);
}

export function createMessageTransportAgentApiTransport(
  transport: MessageTransport,
): AgentApiTransport {
  return {
    async request(route: unknown) {
      if (route !== workspaceInfoRoute)
        return { ok: false, status: 404, error: "Agent API route is unavailable" };
      if (!transport.workspaceInfo)
        return { ok: false, status: 404, error: "Workspace info transport is unavailable" };
      return {
        ok: true,
        status: 200,
        data: await transport.workspaceInfo(),
      };
    },
  };
}
