import { importJWK, SignJWT, type JWK } from "jose";

import type { WorkspaceWorkerTokenIssuer } from "../computers/registration.server";

export type WorkspaceWorkerTokenClaims = {
  readonly workspaceId: string;
  readonly computerId: string;
};

type WorkerJwtConfig = {
  readonly privateJwk: JWK;
  readonly keyId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly lifetimeSeconds: number;
};

export function createWorkspaceWorkerTokenIssuer(
  environment: Record<string, string | undefined> = process.env,
): WorkspaceWorkerTokenIssuer {
  const config = readWorkerJwtConfig(environment);
  let keyPromise: ReturnType<typeof importJWK> | undefined;
  return {
    async issue({ principal, workspaceId, computerId }) {
      keyPromise ??= importJWK(config.privateJwk, "EdDSA");
      return new SignJWT({
        meta: {
          workspace_id: workspaceId,
          computer_id: computerId,
        },
      })
        .setProtectedHeader({ alg: "EdDSA", kid: config.keyId, typ: "JWT" })
        .setSubject(principal.userId)
        .setIssuer(config.issuer)
        .setAudience(config.audience)
        .setIssuedAt()
        .setJti(crypto.randomUUID())
        .setExpirationTime(`${config.lifetimeSeconds}s`)
        .sign(await keyPromise);
    },
  };
}

export async function workspaceWorkerJwks(
  environment: Record<string, string | undefined> = process.env,
): Promise<{ keys: JWK[] }> {
  const config = readWorkerJwtConfig(environment);
  const { d: _private, key_ops: _keyOps, ...publicJwk } = config.privateJwk;
  return {
    keys: [
      {
        ...publicJwk,
        kid: config.keyId,
        alg: "EdDSA",
        use: "sig",
        key_ops: ["verify"],
      },
    ],
  };
}

function readWorkerJwtConfig(environment: Record<string, string | undefined>): WorkerJwtConfig {
  const privateJwkValue = environment.COFORGE_WORKER_JWT_PRIVATE_JWK;
  const keyId = environment.COFORGE_WORKER_JWT_KEY_ID;
  if (!privateJwkValue || !keyId) throw new Error("Workspace Worker JWT is not configured");
  let privateJwk: JWK;
  try {
    privateJwk = JSON.parse(privateJwkValue) as JWK;
  } catch {
    throw new Error("Workspace Worker JWT private JWK is invalid");
  }
  if (privateJwk.kty !== "OKP" || privateJwk.crv !== "Ed25519" || typeof privateJwk.d !== "string")
    throw new Error("Workspace Worker JWT private JWK must be an Ed25519 private key");
  return {
    privateJwk,
    keyId,
    issuer: environment.COFORGE_WORKER_JWT_ISSUER ?? "coforge",
    audience: environment.COFORGE_WORKER_JWT_AUDIENCE ?? "coforge-centrifugo",
    lifetimeSeconds: readLifetime(environment.COFORGE_WORKER_JWT_LIFETIME_SECONDS),
  };
}

function readLifetime(value: string | undefined): number {
  const lifetime = value ? Number(value) : 900;
  if (!Number.isSafeInteger(lifetime) || lifetime < 60 || lifetime > 86_400)
    throw new Error("Workspace Worker JWT lifetime must be between 60 and 86400 seconds");
  return lifetime;
}
