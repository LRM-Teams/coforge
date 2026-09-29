import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";

import { authenticateCentrifugoConnect } from "#src/server/centrifugo/connect-proxy.server";
import {
  createDaemonApiKeyFactory,
  hashDaemonApiKey,
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

const REVOKED_KEY = `dk_${"a".repeat(43)}`;

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
        revocationReason: async () => undefined,
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
      workspaceId: "workspace-1",
      computerId: "computer-1",
    });
    const response = await authenticateCentrifugoConnect(
      connectRequest({ daemonApiKey: keys.token }),
      {
        daemonApiKeys: keys,
        computerBelongsToWorkspace: async () => false,
        revocationReason: async () => undefined,
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      disconnect: { code: 4502, reason: "computer_unlinked" },
    });
  });

  test("refuses a formerly valid key whose Workspace was deleted for good, by its recorded revocation", async () => {
    const asked: string[] = [];
    const response = await authenticateCentrifugoConnect(
      connectRequest({ daemonApiKey: REVOKED_KEY }),
      {
        daemonApiKeys: repository(),
        computerBelongsToWorkspace: async () => true,
        revocationReason: async (apiKeyHash) => {
          asked.push(apiKeyHash);
          return "workspace_deleted";
        },
      },
    );
    expect(asked).toEqual([hashDaemonApiKey(REVOKED_KEY)]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      disconnect: { code: 4501, reason: "workspace_deleted" },
    });
  });

  test("keeps a key with no recorded revocation a retryable authentication failure", async () => {
    const response = await authenticateCentrifugoConnect(
      connectRequest({ daemonApiKey: REVOKED_KEY }),
      {
        daemonApiKeys: repository(),
        computerBelongsToWorkspace: async () => true,
        revocationReason: async () => undefined,
      },
    );
    expect(response.status).toBe(401);
  });

  test("never looks up a revocation for a value that is not a daemon key", async () => {
    let looked = false;
    const response = await authenticateCentrifugoConnect(
      connectRequest({ daemonApiKey: "not-a-key" }),
      {
        daemonApiKeys: repository(),
        computerBelongsToWorkspace: async () => true,
        revocationReason: async () => {
          looked = true;
          return "workspace_deleted";
        },
      },
    );
    expect(looked).toBe(false);
    expect(response.status).toBe(401);
  });

  describe("logs every refusal for good with its reason", () => {
    const warnings: unknown[] = [];
    let warn: ReturnType<typeof spyOn>;
    beforeAll(() => {
      warn = spyOn(console, "warn").mockImplementation((line: unknown) => {
        warnings.push(JSON.parse(String(line)));
      });
    });
    afterEach(() => {
      warnings.length = 0;
    });
    afterAll(() => {
      warn.mockRestore();
    });

    test("an unlinked Computer names the principal", async () => {
      const keys = repository();
      keys.token = await createDaemonApiKeyFactory(keys).create({
        principal: { userId: "user-1" },
        workspaceId: "workspace-1",
        computerId: "computer-1",
      });
      await authenticateCentrifugoConnect(connectRequest({ daemonApiKey: keys.token }), {
        daemonApiKeys: keys,
        computerBelongsToWorkspace: async () => false,
        revocationReason: async () => undefined,
      });
      expect(warnings).toEqual([
        {
          event: "daemon_connect:refused",
          reason: "computer_unlinked",
          workspace_id: "workspace-1",
          computer_id: "computer-1",
        },
      ]);
    });

    test("a revoked key names only the reason", async () => {
      await authenticateCentrifugoConnect(connectRequest({ daemonApiKey: REVOKED_KEY }), {
        daemonApiKeys: repository(),
        computerBelongsToWorkspace: async () => true,
        revocationReason: async () => "workspace_deleted",
      });
      expect(warnings).toEqual([{ event: "daemon_connect:refused", reason: "workspace_deleted" }]);
    });
  });
});
