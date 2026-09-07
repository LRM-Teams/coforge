import "./dom-setup";
import { expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { encodeAgentActivity, WORKSPACE_PROTOCOL_MAJOR } from "@coforge/protocol";

const clients: FakeClient[] = [];
class FakeClient {
  handlers = new Map<string, (event: { channel?: string; data?: Uint8Array }) => void>();
  disconnect = mock(() => {});
  constructor() {
    clients.push(this);
  }
  on(name: string, handler: (event: { channel?: string; data?: Uint8Array }) => void) {
    this.handlers.set(name, handler);
  }
  connect() {
    this.handlers.get("connected")?.({});
  }
  publish(agentId: string, clientSeq: number, workspaceId = "w1") {
    this.handlers.get("publication")?.({
      channel: `activity:${workspaceId}`,
      data: encodeAgentActivity({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: `event-${clientSeq}`,
        workspaceId,
        agentId,
        launchId: "launch",
        clientSeq,
        activity: "running_command",
        level: "info",
        message: "",
        occurredAt: new Date().toISOString(),
      }),
    });
  }
}
mock.module("centrifuge/build/protobuf", () => ({ Centrifuge: FakeClient }));
const { useWorkspaceActivity, activityForAgent } =
  await import("../src/features/agents/workspace-activity-realtime");

test("one workspace connection fans out Agents and preserves live events across delayed history", async () => {
  let resolve!: (value: { workspaceId: string; agents: { id: string; activity: [] }[] }) => void;
  const refresh = mock(
    () =>
      new Promise<{ workspaceId: string; agents: { id: string; activity: [] }[] }>((done) => {
        resolve = done;
      }),
  );
  const getConnectionToken = async () => "token";
  const { result, unmount } = renderHook(() =>
    useWorkspaceActivity({ workspaceId: "w1", refresh, getConnectionToken }),
  );
  expect(clients).toHaveLength(1);
  act(() => {
    clients[0]!.publish("a", 1);
    clients[0]!.publish("b", 2);
    clients[0]!.publish("a", 9, "other");
  });
  await act(async () =>
    resolve({
      workspaceId: "w1",
      agents: [{ id: "a", activity: [] }],
    }),
  );
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.activity.a?.[0]?.clientSeq).toBe(1);
  expect(result.current.activity.b?.[0]?.clientSeq).toBe(2);
  expect(refresh).toHaveBeenCalledTimes(1);
  unmount();
  expect(clients[0]!.disconnect).toHaveBeenCalledTimes(1);
});

test("switching Workspace drops old activity and ignores old pending history", async () => {
  let resolveOld!: (value: { workspaceId: string; agents: [] }) => void;
  const oldRefresh = () =>
    new Promise<{ workspaceId: string; agents: [] }>((resolve) => {
      resolveOld = resolve;
    });
  const refresh = async (): Promise<{ workspaceId: string; agents: [] }> => ({
    workspaceId: "w2",
    agents: [],
  });
  const getConnectionToken = async () => "token";
  const { result, rerender, unmount } = renderHook(
    ({ workspaceId, refresh }) =>
      useWorkspaceActivity({ workspaceId, refresh, getConnectionToken }),
    {
      initialProps: { workspaceId: "w1", refresh: oldRefresh },
    },
  );
  const oldClient = clients.at(-1)!;
  act(() => oldClient.publish("a", 1));
  rerender({ workspaceId: "w2", refresh });
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => resolveOld({ workspaceId: "w1", agents: [] }));
  act(() => oldClient.publish("a", 2));
  expect(result.current.activity).toEqual({});
  expect(oldClient.disconnect).toHaveBeenCalledTimes(1);
  unmount();
});

test("rehydrates again when a reconnect happens during an in-flight snapshot", async () => {
  let resolve!: (value: { workspaceId: string; agents: [] }) => void;
  const refresh = mock(
    () =>
      new Promise<{ workspaceId: string; agents: [] }>((done) => {
        resolve = done;
      }),
  );
  const getConnectionToken = async () => "token";
  const { unmount } = renderHook(() =>
    useWorkspaceActivity({ workspaceId: "w1", refresh, getConnectionToken }),
  );
  act(() => clients.at(-1)!.handlers.get("connected")?.({}));
  await act(async () => resolve({ workspaceId: "w1", agents: [] }));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  unmount();
});

test("a live publication restores activity after history loading fails", async () => {
  const refresh = async () => {
    throw new Error("history unavailable");
  };
  const getConnectionToken = async () => "token";
  const { result, unmount } = renderHook(() =>
    useWorkspaceActivity({ workspaceId: "w1", refresh, getConnectionToken }),
  );
  await waitFor(() => expect(result.current.error).toBe(true));
  act(() => clients.at(-1)!.publish("a", 1));
  expect(activityForAgent(result.current, "a").error).toBe(false);
  expect(activityForAgent(result.current, "b").error).toBe(true);
  expect(result.current.loading).toBe(false);
  expect(result.current.activity.a?.[0]?.activity).toBe("running_command");
  unmount();
});

test("late history failure cannot hide already received activity or resolve unrelated Agents", async () => {
  let reject!: (error: Error) => void;
  const refresh = () =>
    new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
  const getConnectionToken = async () => "token";
  const { result, unmount } = renderHook(() =>
    useWorkspaceActivity({ workspaceId: "w1", refresh, getConnectionToken }),
  );
  act(() => clients.at(-1)!.publish("a", 1));
  expect(activityForAgent(result.current, "a").loading).toBe(false);
  expect(activityForAgent(result.current, "b").loading).toBe(true);
  await act(async () => reject(new Error("history unavailable")));
  expect(activityForAgent(result.current, "a").error).toBe(false);
  expect(activityForAgent(result.current, "a").activity[0]?.clientSeq).toBe(1);
  expect(activityForAgent(result.current, "b").error).toBe(true);
  unmount();
});
