import { importJWK, jwtVerify, SignJWT, type JWK } from "jose";

import type { DaemonTokenIssuer } from "../computers/registration.server";

export type DaemonTokenClaims = {
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

export function createDaemonTokenIssuer(
  environment: Record<string, string | undefined> = process.env,
): DaemonTokenIssuer {
  const config = readWorkerJwtConfig(environment);
  let keyPromise: ReturnType<typeof importJWK> | undefined;
  return {
    async issue({ principal, workspaceId, computerId }) {
      keyPromise ??= importJWK(config.privateJwk, "EdDSA");
      return new SignJWT({
        workspace_id: workspaceId,
        computer_id: computerId,
        meta: { workspace_id: workspaceId, computer_id: computerId },
        channels: [`workspace:${workspaceId}`, `activity:${workspaceId}`],
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

/** Verify the bearer token supplied by the Centrifugo proxy. */
export async function verifyDaemonToken(
  token: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<{ userId: string; workspaceId: string; computerId: string }> {
  const config = readWorkerJwtConfig(environment);
  const { d: _private, key_ops: _keyOps, ...publicJwk } = config.privateJwk;
  const key = await importJWK(publicJwk, "EdDSA");
  const { payload } = await jwtVerify(token, key, {
    issuer: config.issuer,
    audience: config.audience,
  });
  if (
    typeof payload.sub !== "string" ||
    typeof payload.workspace_id !== "string" ||
    typeof payload.computer_id !== "string"
  )
    throw new Error("daemon runtime JWT is missing identity claims");
  return {
    userId: payload.sub,
    workspaceId: payload.workspace_id,
    computerId: payload.computer_id,
  };
}

export async function daemonRuntimeJwks(
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
  if (!privateJwkValue || !keyId) throw new Error("Daemon Runtime JWT is not configured");
  let privateJwk: JWK;
  try {
    privateJwk = JSON.parse(privateJwkValue) as JWK;
  } catch {
    throw new Error("Daemon Runtime JWT private JWK is invalid");
  }
  if (privateJwk.kty !== "OKP" || privateJwk.crv !== "Ed25519" || typeof privateJwk.d !== "string")
    throw new Error("Daemon Runtime JWT private JWK must be an Ed25519 private key");
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
    throw new Error("Daemon Runtime JWT lifetime must be between 60 and 86400 seconds");
  return lifetime;
}
