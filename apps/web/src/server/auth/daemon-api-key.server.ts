import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type JWK } from "jose";

import type { DaemonApiKeyFactory } from "../computers/registration.server";

export type DaemonApiKeyClaims = {
  readonly userId: string;
  readonly workspaceId: string;
  readonly computerId: string;
};

export type DaemonApiKeyRecord = {
  id: string;
  apiKeyHash: string;
  workspaceId: string;
  computerId: string;
  ownerId: string;
  revokedAt: Date | null;
};

export interface DaemonApiKeyRepository {
  replaceActive(record: DaemonApiKeyRecord): Promise<void>;
  findByHash(hash: string): Promise<DaemonApiKeyRecord | undefined>;
  markUsed(id: string): Promise<void>;
}

const DAEMON_API_KEY = /^dk_[A-Za-z0-9_-]{43}$/;

export function hashDaemonApiKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createDaemonApiKeyFactory(repository: DaemonApiKeyRepository): DaemonApiKeyFactory {
  return {
    async create({ principal, workspaceId, computerId }) {
      const apiKey = `dk_${randomBytes(32).toString("base64url")}`;
      await repository.replaceActive({
        id: crypto.randomUUID(),
        apiKeyHash: hashDaemonApiKey(apiKey),
        workspaceId,
        computerId,
        ownerId: principal.userId,
        revokedAt: null,
      });
      return apiKey;
    },
  };
}

export async function verifyDaemonApiKey(
  apiKey: string,
  repository: DaemonApiKeyRepository,
): Promise<DaemonApiKeyClaims> {
  if (!DAEMON_API_KEY.test(apiKey)) throw new Error("invalid Daemon API key");
  const actual = Buffer.from(hashDaemonApiKey(apiKey));
  const record = await repository.findByHash(actual.toString());
  if (!record || record.revokedAt) throw new Error("invalid Daemon API key");
  const expected = Buffer.from(record.apiKeyHash);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new Error("invalid Daemon API key");
  await repository.markUsed(record.id);
  return {
    userId: record.ownerId,
    workspaceId: record.workspaceId,
    computerId: record.computerId,
  };
}

/** User-authorized Computer registration still uses the existing JWT issuer. */
export async function computerRegistrationJwks(
  environment: Record<string, string | undefined> = process.env,
): Promise<{ keys: JWK[] }> {
  const value = environment.COFORGE_WORKER_JWT_PRIVATE_JWK;
  if (!value) throw new Error("Computer registration JWT is not configured");
  const privateJwk = JSON.parse(value) as JWK;
  const { d: _privateKey, key_ops: _keyOps, ...publicJwk } = privateJwk;
  return {
    keys: [
      {
        ...publicJwk,
        kid: environment.COFORGE_WORKER_JWT_KEY_ID,
        alg: "EdDSA",
        use: "sig",
        key_ops: ["verify"],
      },
    ],
  };
}
