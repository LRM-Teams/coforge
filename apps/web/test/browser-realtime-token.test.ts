import { expect, test } from "bun:test";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import { issueBrowserRealtimeToken } from "../src/server/auth/browser-realtime-token.server";

test("Activity token grants only its authorized Workspace channel; status tokens stay JSON-safe", async () => {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  const environment = {
    COFORGE_WORKER_JWT_PRIVATE_JWK: JSON.stringify(await exportJWK(privateKey)),
    COFORGE_WORKER_JWT_KEY_ID: "test-key",
  };
  const activity = await issueBrowserRealtimeToken(
    { userId: "user-1", workspaceId: "workspace-1", stream: "activity" },
    environment,
  );
  const verified = await jwtVerify(activity, publicKey, {
    issuer: "coforge",
    audience: "coforge-centrifugo",
  });
  expect(verified.payload.sub).toBe("user-1");
  expect(verified.payload.channels).toEqual(["activity:workspace-1"]);
  const status = await issueBrowserRealtimeToken(
    { userId: "user-1", workspaceId: "workspace-1" },
    environment,
  );
  expect((await jwtVerify(status, publicKey)).payload.channels).toEqual(["status:workspace-1"]);
});
