/** Public Agent API route contract shared by clients and HTTP adapters. */
export const agentApiRoutes = {
  proxy: {
    workspace: { method: "GET", path: "/api/agent/v1/workspace" },
    manual: {
      get: { method: "GET", path: "/api/agent/v1/manual" },
      search: { method: "GET", path: "/api/agent/v1/manual/search" },
    },
    // Local-only: answered entirely by the Daemon's Agent proxy and never forwarded to Web/backend
    // (`coforge version`; see `docs/adr/0036-agent-manual.md`'s placement-table rows).
    version: { method: "GET", path: "/api/agent/v1/version" },
    messages: { method: "POST", path: "/api/agent/v1/messages" },
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
    causal: { method: "POST", path: "/api/agent/v1/causal" },
    users: {
      method: "GET",
      path: (name: string) => `/api/agent/v1/users/${encodeURIComponent(name)}`,
    },
    profile: {
      get: { method: "GET", path: "/api/agent/v1/profile" },
      update: { method: "POST", path: "/api/agent/v1/profile" },
    },
  },
  local: {
    messages: { method: "POST", path: "/api/agent/v1/messages" },
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
    causal: { method: "POST", path: "/api/agent/v1/causal" },
    attachments: {
      method: "GET",
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
    causal: { method: "POST", path: "/api/agent/v1/causal" },
    attachments: {
      method: "GET",
      collectionPath: "/api/agent/v1/attachments",
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
