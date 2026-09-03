import { describe, expect, test } from "bun:test";

import { authenticateCentrifugoConnect } from "../src/server/centrifugo/connect-proxy.server";
import {
  createDaemonApiKeyFactory,
  type DaemonApiKeyRepository,
} from "../src/server/auth/daemon-api-key.server";

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
      { daemonApiKeys: keys, computerBelongsToWorkspace: async () => true },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: {
        user: "user-1",
        meta: { workspace_id: "workspace-1", computer_id: "computer-1" },
        subs: { "daemon:computer-1": {} },
      },
    });
  });

  test("rejects a daemon key for an unregistered computer", async () => {
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
      { daemonApiKeys: keys, computerBelongsToWorkspace: async () => false },
    );
    expect(response.status).toBe(401);
  });
});
