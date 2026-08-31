import { describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";

import {
  createDaemonTokenIssuer,
  verifyDaemonToken,
  daemonRuntimeJwks,
} from "../src/server/auth/daemon-token.server";

describe("Daemon Runtime JWT", () => {
  test("issues an Ed25519 JWT that Centrifugo can verify from JWKS", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    const publicJwk = await exportJWK(publicKey);
    const environment = {
      COFORGE_WORKER_JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
      COFORGE_WORKER_JWT_KEY_ID: "worker-key-1",
      COFORGE_WORKER_JWT_ISSUER: "coforge",
      COFORGE_WORKER_JWT_AUDIENCE: "coforge-centrifugo",
      COFORGE_WORKER_JWT_LIFETIME_SECONDS: "900",
    };
    const token = await createDaemonTokenIssuer(environment).issue({
      principal: { userId: "user-1" },
      workspaceId: "workspace-1",
      computerId: "computer-1",
    });
    const verified = await jwtVerify(
      token,
      await import("jose").then(({ importJWK }) => importJWK(publicJwk, "EdDSA")),
      {
        issuer: "coforge",
        audience: "coforge-centrifugo",
      },
    );
    expect(verified.payload.sub).toBe("user-1");
    expect(verified.payload.workspace_id).toBe("workspace-1");
    expect(verified.payload.computer_id).toBe("computer-1");
    expect(verified.payload.meta).toEqual({
      workspace_id: "workspace-1",
      computer_id: "computer-1",
    });
    expect(verified.payload.channels).toEqual(["workspace:workspace-1", "activity:workspace-1"]);
    expect(await verifyDaemonToken(token, environment)).toEqual({
      userId: "user-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
    });
    expect(await daemonRuntimeJwks(environment)).toEqual({
      keys: [{ ...publicJwk, kid: "worker-key-1", alg: "EdDSA", use: "sig", key_ops: ["verify"] }],
    });
  });
});
