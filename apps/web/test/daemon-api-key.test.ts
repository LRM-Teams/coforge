import { describe, expect, test } from "bun:test";

import {
  createDaemonApiKeyFactory,
  computerRegistrationJwks,
  hashDaemonApiKey,
  verifyDaemonApiKey,
  type DaemonApiKeyRecord,
  type DaemonApiKeyRepository,
} from "../src/server/auth/daemon-api-key.server";

class MemoryDaemonApiKeys implements DaemonApiKeyRepository {
  records = new Map<string, DaemonApiKeyRecord>();
  async replaceActive(record: DaemonApiKeyRecord) {
    for (const [hash, value] of this.records)
      if (value.workspaceId === record.workspaceId && value.computerId === record.computerId)
        this.records.set(hash, { ...value, revokedAt: new Date() });
    this.records.set(record.apiKeyHash, record);
  }
  async findByHash(hash: string) {
    return this.records.get(hash);
  }
  async markUsed() {}
}

describe("Daemon API key", () => {
  test("publishes only the Computer registration public key", async () => {
    const jwks = await computerRegistrationJwks({
      COFORGE_WORKER_JWT_PRIVATE_JWK: JSON.stringify({
        kty: "OKP",
        crv: "Ed25519",
        x: "public-key",
        d: "private-key",
      }),
      COFORGE_WORKER_JWT_KEY_ID: "computer-registration",
    });
    expect(jwks.keys[0]).toMatchObject({ x: "public-key", kid: "computer-registration" });
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });

  test("issues and verifies a long-lived scoped key", async () => {
    const repository = new MemoryDaemonApiKeys();
    const token = await createDaemonApiKeyFactory(repository).create({
      principal: { userId: "user-1" },
      workspaceId: "workspace-1",
      computerId: "computer-1",
    });
    expect(token).toMatch(/^dk_[A-Za-z0-9_-]{43}$/);
    expect(await verifyDaemonApiKey(token, repository)).toEqual({
      userId: "user-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
    });
  });

  test("revokes the previous key when registration replaces it", async () => {
    const repository = new MemoryDaemonApiKeys();
    const factory = createDaemonApiKeyFactory(repository);
    const first = await factory.create({
      principal: { userId: "u" },
      workspaceId: "w",
      computerId: "c",
    });
    const second = await factory.create({
      principal: { userId: "u" },
      workspaceId: "w",
      computerId: "c",
    });
    await expect(verifyDaemonApiKey(first, repository)).rejects.toThrow("invalid Daemon API key");
    expect(await verifyDaemonApiKey(second, repository)).toMatchObject({
      workspaceId: "w",
      computerId: "c",
    });
    expect(hashDaemonApiKey(second)).toBeTruthy();
  });
});
