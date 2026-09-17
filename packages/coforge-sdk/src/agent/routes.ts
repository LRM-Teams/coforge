/** Public Agent API route contract shared by clients and HTTP adapters. */
export const agentApiRoutes = {
  proxy: {
    workspace: { method: "GET", path: "/api/agent/v1/workspace" },
    messages: { method: "POST", path: "/api/agent/v1/messages" },
    inbox: { method: "POST", path: "/api/agent/v1/inbox" },
    reminders: { method: "POST", path: "/api/agent/v1/reminders" },
    tasks: { method: "POST", path: "/api/agent/v1/tasks" },
    weeklyReports: { method: "POST", path: "/api/agent/v1/weekly-reports" },
    githubCredentials: { method: "POST", path: "/api/agent/v1/github-credentials" },
    channels: { method: "POST", path: "/api/agent/v1/channels" },
  },
  local: {
    messages: { method: "POST", path: "/api/agent/v1/messages" },
    inbox: { method: "POST", path: "/api/agent/v1/inbox" },
    reminders: { method: "POST", path: "/api/agent/v1/reminders" },
    tasks: { method: "POST", path: "/api/agent/v1/tasks" },
    weeklyReports: { method: "POST", path: "/api/agent/v1/weekly-reports" },
    githubCredentials: { method: "POST", path: "/api/agent/v1/github-credentials" },
    channels: { method: "POST", path: "/api/agent/v1/channels" },
    attachments: {
      method: "GET",
      path: (attachmentId: string) =>
        `/api/agent/v1/attachments/${encodeURIComponent(attachmentId)}`,
      upload: { method: "POST", path: "/api/agent/v1/attachments" },
    },
  },
  cloud: {
    workspace: { info: { method: "GET", path: "/api/agent/v1/workspace" } },
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
    weeklyReports: { method: "POST", path: "/api/agent/v1/weekly-reports" },
    githubCredentials: { method: "POST", path: "/api/agent/v1/github-credentials" },
    attachments: {
      method: "GET",
      collectionPath: "/api/agent/v1/attachments",
      path: (attachmentId: string) =>
        `/api/agent/v1/attachments/${encodeURIComponent(attachmentId)}`,
      upload: { method: "POST", path: "/api/agent/v1/attachments" },
    },
  },
  workspace: {
    info: {
      key: "workspaceInfo",
      method: "GET",
      path: "/api/agent/v1/workspace",
    },
  },
} as const;

export const workspaceInfoRoute = agentApiRoutes.workspace.info;
