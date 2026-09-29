import { describe, expect, test } from "bun:test";

import { authenticateCentrifugoConnect } from "#src/server/centrifugo/connect-proxy.server";
import {
  createDaemonApiKeyFactory,
  type DaemonApiKeyRepository,
} from "#src/server/auth/daemon-api-key.server";

const repository = (): DaemonApiKeyRepository & { token?: string } => {
  const records = new Map<string, any>();
  return {
    async replaceActive(record) {
      records.set(record.apiKeyHash, record);
    },
    async findByHash(hash) {
      return records.get(hash);
    },
    async markUsed() {},
    token: undefined,
  };
};

const WORKSPACE_ID = "0f3c2b8e-5d6a-4c1e-9b7f-2a4d6e8f0a1b";
const UNKNOWN_KEY = `dk_${"a".repeat(43)}`;

function connectRequest(data: unknown): Request {
  return new Request("http://backend", { method: "POST", body: JSON.stringify({ data }) });
}

describe("Centrifugo Connect Proxy", () => {
  test("authenticates a daemon key from connect data and returns its subscriptions", async () => {
    const keys = repository();
    keys.token = await createDaemonApiKeyFactory(keys).create({
      principal: { userId: "user-1" },
      workspaceId: "workspace-1",
      computerId: "computer-1",
    });
    const response = await authenticateCentrifugoConnect(
      new Request("http://backend", {
        method: "POST",
        body: JSON.stringify({ data: { daemonApiKey: keys.token } }),
      }),
      {
        daemonApiKeys: keys,
        computerBelongsToWorkspace: async () => true,
        workspaceExists: async () => true,
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: {
        user: "user-1",
        meta: { workspace_id: "workspace-1", computer_id: "computer-1" },
        subs: { "daemon:workspace-1:computer-1": {} },
      },
    });
  });

  test("refuses a valid key whose Computer is no longer linked to the Workspace for good", async () => {
    const keys = repository();
    keys.token = await createDaemonApiKeyFactory(keys).create({
      principal: { userId: "user-1" },
      workspaceId: WORKSPACE_ID,
      computerId: "computer-1",
    });
    const response = await authenticateCentrifugoConnect(
      connectRequest({ daemonApiKey: keys.token, workspaceId: WORKSPACE_ID }),
      {
        daemonApiKeys: keys,
        computerBelongsToWorkspace: async () => false,
        workspaceExists: async () => true,
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      disconnect: { code: 4502, reason: "computer_unlinked" },
    });
  });

  test("refuses an unknown key for a Workspace that no longer exists for good", async () => {
    const checked: string[] = [];
    const response = await authenticateCentrifugoConnect(
      connectRequest({ daemonApiKey: UNKNOWN_KEY, workspaceId: WORKSPACE_ID }),
      {
        daemonApiKeys: repository(),
        computerBelongsToWorkspace: async () => true,
        workspaceExists: async (workspaceId) => {
          checked.push(workspaceId);
          return false;
        },
      },
    );
    expect(checked).toEqual([WORKSPACE_ID]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      disconnect: { code: 4501, reason: "workspace_deleted" },
    });
  });

  test("keeps an unknown key for an existing Workspace a retryable authentication failure", async () => {
    const response = await authenticateCentrifugoConnect(
      connectRequest({ daemonApiKey: UNKNOWN_KEY, workspaceId: WORKSPACE_ID }),
      {
        daemonApiKeys: repository(),
        computerBelongsToWorkspace: async () => true,
        workspaceExists: async () => true,
      },
    );
    expect(response.status).toBe(401);
  });

  test("never looks up a Workspace id that is not a UUID", async () => {
    let looked = false;
    const response = await authenticateCentrifugoConnect(
      connectRequest({ daemonApiKey: UNKNOWN_KEY, workspaceId: "not-a-uuid" }),
      {
        daemonApiKeys: repository(),
        computerBelongsToWorkspace: async () => true,
        workspaceExists: async () => {
          looked = true;
          return false;
        },
      },
    );
    expect(looked).toBe(false);
    expect(response.status).toBe(401);
  });
});
