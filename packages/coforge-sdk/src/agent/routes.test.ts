import { expect, test } from "bun:test";
import { agentApiRoutes } from "./routes";

test("keeps the versioned workspace route stable", () => {
  expect(agentApiRoutes.cloud.workspace.info).toEqual({
    method: "GET",
    path: "/api/agent/v1/workspace",
  });
});

test("uses versioned Agent API routes for the Proxy and cloud", () => {
  expect(agentApiRoutes.proxy.messages.path).toBe("/api/agent/v1/messages");
  expect(agentApiRoutes.proxy.tasks.path).toBe("/api/agent/v1/tasks");
  expect(agentApiRoutes.proxy.reminders.path).toBe("/api/agent/v1/reminders");
  expect(agentApiRoutes.proxy.inbox.path).toBe("/api/agent/v1/inbox");
  expect(agentApiRoutes.proxy.messages.path).toBe(agentApiRoutes.cloud.messages.list.path);
});

test("builds encoded resource paths from the shared contract", () => {
  expect(agentApiRoutes.cloud.attachments.path("a/b")).toBe("/api/agent/v1/attachments/a%2Fb");
  expect(agentApiRoutes.local.attachments.path("attachment id")).toBe(
    "/api/agent/v1/attachments/attachment%20id",
  );
  expect(agentApiRoutes.cloud.channels.mute.path("channel 1")).toBe(
    "/api/agent/v1/channels/channel%201/mute",
  );
  expect(agentApiRoutes.cloud.threads.unfollow.path("thread#1")).toBe(
    "/api/agent/v1/threads/thread%231/unfollow",
  );
});
