/** Public Agent API route contract shared by clients and HTTP adapters. */
export const agentApiRoutes = {
  proxy: {
    workspace: { method: "GET", path: "/api/agent/v1/workspace" },
    manual: {
      get: { method: "GET", path: "/api/agent/v1/manual" },
      search: { method: "GET", path: "/api/agent/v1/manual/search" },
    },
    // Local-only: answered entirely by the Daemon's Agent proxy and never forwarded to Web/backend
    // (`coforge version`).
    version: { method: "GET", path: "/api/agent/v1/version" },
    messages: { method: "POST", path: "/api/agent/v1/messages" },
    // Local-only, like `version`: `DaemonRuntime.inbox()` assembles the answer from the Agent's own
    // state (message attention plus the app inbox) and never forwards it to Web/backend. It also
    // takes no key argument, unlike the runtime methods that do reach Web.
    inbox: { method: "POST", path: "/api/agent/v1/inbox" },
    reminders: { method: "POST", path: "/api/agent/v1/reminders" },
    tasks: { method: "POST", path: "/api/agent/v1/tasks" },
    actionPrepare: { method: "POST", path: "/api/agent/v1/actions/prepare" },
    weeklyReports: { method: "POST", path: "/api/agent/v1/weekly-reports" },
    weeklyReportCollect: { method: "POST", path: "/api/agent/v1/weekly-report-collect" },
    weeklyReportKeyPoints: { method: "POST", path: "/api/agent/v1/weekly-report-key-points" },
    githubCredentials: { method: "POST", path: "/api/agent/v1/github-credentials" },
    githubCommitTrailers: { method: "POST", path: "/api/agent/v1/github-commit-trailers" },
    channels: { method: "POST", path: "/api/agent/v1/channels" },
    openviking: { method: "POST", path: "/api/agent/v1/openviking" },
    users: {
      method: "GET",
      path: (name: string) => `/api/agent/v1/users/${encodeURIComponent(name)}`,
    },
    mentionActions: {
      pending: { method: "GET", path: "/api/agent/v1/mention-actions/pending" },
      execute: { method: "POST", path: "/api/agent/v1/mention-actions/execute" },
    },
    profile: {
      get: { method: "GET", path: "/api/agent/v1/profile" },
      update: { method: "POST", path: "/api/agent/v1/profile" },
    },
  },
  local: {
    messages: {
      method: "POST",
      path: "/api/agent/v1/messages",
    },
    // Local-only, like `version`; see the same entry under `proxy`.
    inbox: { method: "POST", path: "/api/agent/v1/inbox" },
    reminders: { method: "POST", path: "/api/agent/v1/reminders" },
    tasks: { method: "POST", path: "/api/agent/v1/tasks" },
    actionPrepare: { method: "POST", path: "/api/agent/v1/actions/prepare" },
    weeklyReports: { method: "POST", path: "/api/agent/v1/weekly-reports" },
    weeklyReportCollect: { method: "POST", path: "/api/agent/v1/weekly-report-collect" },
    weeklyReportKeyPoints: { method: "POST", path: "/api/agent/v1/weekly-report-key-points" },
    githubCredentials: { method: "POST", path: "/api/agent/v1/github-credentials" },
    githubCommitTrailers: { method: "POST", path: "/api/agent/v1/github-commit-trailers" },
    channels: { method: "POST", path: "/api/agent/v1/channels" },
    openviking: { method: "POST", path: "/api/agent/v1/openviking" },
    attachments: {
      method: "GET",
      /** Served by Web ahead of the id route: what a client may upload, and whether it uploads
       * directly. It was reachable before this declaration only because the proxy forwards any
       * segment after the attachment prefix as an opaque id. */
      capabilities: { method: "GET", path: "/api/agent/v1/attachments/capabilities" },
      path: (attachmentId: string) =>
        `/api/agent/v1/attachments/${encodeURIComponent(attachmentId)}`,
      upload: { method: "POST", path: "/api/agent/v1/attachments" },
    },
    attachmentUploadSessions: {
      create: { method: "POST", path: "/api/agent/v1/attachment-upload-sessions" },
      complete: {
        method: "POST",
        path: (uploadId: string) =>
          `/api/agent/v1/attachment-upload-sessions/${encodeURIComponent(uploadId)}/complete`,
      },
      cancel: {
        method: "DELETE",
        path: (uploadId: string) =>
          `/api/agent/v1/attachment-upload-sessions/${encodeURIComponent(uploadId)}`,
      },
      get: {
        method: "GET",
        path: (uploadId: string) =>
          `/api/agent/v1/attachment-upload-sessions/${encodeURIComponent(uploadId)}`,
      },
    },
    users: {
      method: "GET",
      path: (name: string) => `/api/agent/v1/users/${encodeURIComponent(name)}`,
    },
    mentionActions: {
      pending: { method: "GET", path: "/api/agent/v1/mention-actions/pending" },
      execute: { method: "POST", path: "/api/agent/v1/mention-actions/execute" },
    },
    profile: {
      get: { method: "GET", path: "/api/agent/v1/profile" },
      update: { method: "POST", path: "/api/agent/v1/profile" },
    },
  },
  cloud: {
    workspace: { info: { method: "GET", path: "/api/agent/v1/workspace" } },
    manual: {
      get: { method: "GET", path: "/api/agent/v1/manual" },
      search: { method: "GET", path: "/api/agent/v1/manual/search" },
    },
    events: { method: "GET", path: "/api/agent/v1/events" },
    messages: {
      list: { method: "GET", path: "/api/agent/v1/messages" },
      search: { method: "GET", path: "/api/agent/v1/messages/search" },
      send: { method: "POST", path: "/api/agent/v1/messages" },
      resolve: {
        method: "GET",
        path: (messageId: string) =>
          `/api/agent/v1/messages/${encodeURIComponent(messageId)}/resolve`,
      },
      reactions: {
        path: (messageId: string) =>
          `/api/agent/v1/messages/${encodeURIComponent(messageId)}/reactions`,
        add: { method: "POST" },
        remove: { method: "DELETE" },
      },
    },
    channels: {
      mute: {
        method: "POST",
        path: (channelId: string) => `/api/agent/v1/channels/${encodeURIComponent(channelId)}/mute`,
      },
      unmute: {
        method: "POST",
        path: (channelId: string) =>
          `/api/agent/v1/channels/${encodeURIComponent(channelId)}/unmute`,
      },
      create: { method: "POST", path: "/api/agent/v1/channels" },
      info: {
        method: "GET",
        path: (channelId: string) => `/api/agent/v1/channels/${encodeURIComponent(channelId)}`,
      },
      update: {
        method: "PATCH",
        path: (channelId: string) => `/api/agent/v1/channels/${encodeURIComponent(channelId)}`,
      },
      members: {
        method: "GET",
        path: (channelId: string) =>
          `/api/agent/v1/channels/${encodeURIComponent(channelId)}/members`,
      },
      addMember: {
        method: "POST",
        path: (channelId: string) =>
          `/api/agent/v1/channels/${encodeURIComponent(channelId)}/members`,
      },
      removeMember: {
        method: "DELETE",
        path: (channelId: string) =>
          `/api/agent/v1/channels/${encodeURIComponent(channelId)}/members`,
      },
      join: {
        method: "POST",
        path: (channelId: string) => `/api/agent/v1/channels/${encodeURIComponent(channelId)}/join`,
      },
      leave: {
        method: "POST",
        path: (channelId: string) =>
          `/api/agent/v1/channels/${encodeURIComponent(channelId)}/leave`,
      },
      archive: {
        method: "POST",
        path: (channelId: string) =>
          `/api/agent/v1/channels/${encodeURIComponent(channelId)}/archive`,
      },
      unarchive: {
        method: "POST",
        path: (channelId: string) =>
          `/api/agent/v1/channels/${encodeURIComponent(channelId)}/unarchive`,
      },
    },
    threads: {
      unfollow: {
        method: "POST",
        path: (threadId: string) =>
          `/api/agent/v1/threads/${encodeURIComponent(threadId)}/unfollow`,
      },
    },
    reminders: { method: "POST", path: "/api/agent/v1/reminders" },
    tasks: { method: "POST", path: "/api/agent/v1/tasks" },
    actionPrepare: { method: "POST", path: "/api/agent/v1/actions/prepare" },
    weeklyReports: { method: "POST", path: "/api/agent/v1/weekly-reports" },
    weeklyReportCollect: { method: "POST", path: "/api/agent/v1/weekly-report-collect" },
    weeklyReportKeyPoints: { method: "POST", path: "/api/agent/v1/weekly-report-key-points" },
    githubCredentials: { method: "POST", path: "/api/agent/v1/github-credentials" },
    githubCommitTrailers: { method: "POST", path: "/api/agent/v1/github-commit-trailers" },
    openviking: { method: "POST", path: "/api/agent/v1/openviking" },
    attachments: {
      method: "GET",
      collectionPath: "/api/agent/v1/attachments",
      /** Served by Web ahead of the id route; see the same entry under `proxy`. */
      capabilities: { method: "GET", path: "/api/agent/v1/attachments/capabilities" },
      path: (attachmentId: string) =>
        `/api/agent/v1/attachments/${encodeURIComponent(attachmentId)}`,
      upload: { method: "POST", path: "/api/agent/v1/attachments" },
    },
    attachmentUploadSessions: {
      create: { method: "POST", path: "/api/agent/v1/attachment-upload-sessions" },
      complete: {
        method: "POST",
        path: (uploadId: string) =>
          `/api/agent/v1/attachment-upload-sessions/${encodeURIComponent(uploadId)}/complete`,
      },
      cancel: {
        method: "DELETE",
        path: (uploadId: string) =>
          `/api/agent/v1/attachment-upload-sessions/${encodeURIComponent(uploadId)}`,
      },
      get: {
        method: "GET",
        path: (uploadId: string) =>
          `/api/agent/v1/attachment-upload-sessions/${encodeURIComponent(uploadId)}`,
      },
    },
    users: {
      method: "GET",
      path: (name: string) => `/api/agent/v1/users/${encodeURIComponent(name)}`,
    },
    mentionActions: {
      pending: { method: "GET", path: "/api/agent/v1/mention-actions/pending" },
      execute: { method: "POST", path: "/api/agent/v1/mention-actions/execute" },
    },
    profile: {
      get: { method: "GET", path: "/api/agent/v1/profile" },
      update: { method: "POST", path: "/api/agent/v1/profile" },
    },
  },
  workspace: {
    info: {
      key: "workspaceInfo",
      method: "GET",
      path: "/api/agent/v1/workspace",
    },
  },
  manual: {
    get: {
      key: "manualGet",
      method: "GET",
      path: "/api/agent/v1/manual",
    },
    search: {
      key: "manualSearch",
      method: "GET",
      path: "/api/agent/v1/manual/search",
    },
  },
} as const;

export const workspaceInfoRoute = agentApiRoutes.workspace.info;
