import { expect, test } from "bun:test";
import { agentApiRoutes } from "./routes";

test("keeps the versioned workspace route stable", () => {
  expect(agentApiRoutes.cloud.workspace.info).toEqual({
    method: "GET",
    path: "/api/agent/v1/workspace",
  });
});

test("exposes the cloud events drain route", () => {
  expect(agentApiRoutes.cloud.events).toEqual({
    method: "GET",
    path: "/api/agent/v1/events",
  });
});

test("exposes a dedicated cloud message search route distinct from read", () => {
  expect(agentApiRoutes.cloud.messages.search).toEqual({
    method: "GET",
    path: "/api/agent/v1/messages/search",
  });
  expect(agentApiRoutes.cloud.messages.search.path).not.toBe(
    agentApiRoutes.cloud.messages.list.path,
  );
});

test("uses versioned Agent API routes for the Proxy and cloud", () => {
  expect(agentApiRoutes.proxy.messages.path).toBe("/api/agent/v1/messages");
  expect(agentApiRoutes.proxy.tasks.path).toBe("/api/agent/v1/tasks");
  expect(agentApiRoutes.proxy.weeklyReports.path).toBe("/api/agent/v1/weekly-reports");
  expect(agentApiRoutes.proxy.weeklyReportCollect.path).toBe("/api/agent/v1/weekly-report-collect");
  expect(agentApiRoutes.proxy.weeklyReportCollect.path).toBe(
    agentApiRoutes.cloud.weeklyReportCollect.path,
  );
  expect(agentApiRoutes.proxy.weeklyReportKeyPoints.path).toBe(
    "/api/agent/v1/weekly-report-key-points",
  );
  expect(agentApiRoutes.proxy.weeklyReportKeyPoints.path).toBe(
    agentApiRoutes.cloud.weeklyReportKeyPoints.path,
  );
  expect(agentApiRoutes.proxy.reminders.path).toBe("/api/agent/v1/reminders");
  expect(agentApiRoutes.proxy.inbox.path).toBe("/api/agent/v1/inbox");
  expect(agentApiRoutes.proxy.messages.path).toBe(agentApiRoutes.cloud.messages.list.path);
});

test("builds encoded resource paths from the shared contract", () => {
  expect(agentApiRoutes.cloud.attachments.path("a/b")).toBe("/api/agent/v1/attachments/a%2Fb");
  expect(agentApiRoutes.local.attachments.path("attachment id")).toBe(
    "/api/agent/v1/attachments/attachment%20id",
  );
  expect(agentApiRoutes.cloud.attachments.collectionPath).toBe("/api/agent/v1/attachments");
  expect(agentApiRoutes.cloud.attachments.upload).toEqual({
    method: "POST",
    path: "/api/agent/v1/attachments",
  });
  expect(agentApiRoutes.local.attachments.upload).toEqual({
    method: "POST",
    path: "/api/agent/v1/attachments",
  });
  expect(agentApiRoutes.cloud.channels.mute.path("channel 1")).toBe(
    "/api/agent/v1/channels/channel%201/mute",
  );
  expect(agentApiRoutes.cloud.threads.unfollow.path("thread#1")).toBe(
    "/api/agent/v1/threads/thread%231/unfollow",
  );
});

test("builds resolve and reaction routes for the messages resource", () => {
  expect(agentApiRoutes.cloud.messages.resolve).toEqual({
    method: "GET",
    path: agentApiRoutes.cloud.messages.resolve.path,
  });
  expect(agentApiRoutes.cloud.messages.resolve.path("abcd1234")).toBe(
    "/api/agent/v1/messages/abcd1234/resolve",
  );
  expect(agentApiRoutes.cloud.messages.reactions.path("abcd1234")).toBe(
    "/api/agent/v1/messages/abcd1234/reactions",
  );
  expect(agentApiRoutes.cloud.messages.reactions.add).toEqual({ method: "POST" });
  expect(agentApiRoutes.cloud.messages.reactions.remove).toEqual({ method: "DELETE" });
});
