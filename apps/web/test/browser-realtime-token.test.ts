import { expect, test } from "bun:test";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import {
  issueConversationRealtimeToken,
  issueBrowserRealtimeToken,
} from "../src/server/auth/browser-realtime-token.server";

async function signingFixture() {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    extractable: true,
  });
  const environment = {
    COFORGE_WORKER_JWT_PRIVATE_JWK: JSON.stringify(await exportJWK(privateKey)),
    COFORGE_WORKER_JWT_KEY_ID: "realtime-test",
    COFORGE_WORKER_JWT_ISSUER: "coforge-test",
    COFORGE_WORKER_JWT_AUDIENCE: "coforge-test-centrifugo",
  };
  return { environment, publicKey };
}

test("connection token includes only the selected Workspace status channel", async () => {
  const { environment, publicKey } = await signingFixture();
  const token = await issueBrowserRealtimeToken(
    { userId: "user-1", workspaceId: "workspace-1" },
    environment,
  );
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: "coforge-test",
    audience: "coforge-test-centrifugo",
  });

  expect(payload.sub).toBe("user-1");
  expect(payload.channels).toEqual(["status:workspace-1"]);
  expect(payload.channel).toBeUndefined();
});

test("subscription token authorizes one User for one conversation channel", async () => {
  const { environment, publicKey } = await signingFixture();
  const token = await issueConversationRealtimeToken(
    {
      userId: "user-1",
      conversationId: "12345678-0000-4000-8000-000000000001",
    },
    environment,
  );
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: "coforge-test",
    audience: "coforge-test-centrifugo",
  });

  expect(payload.sub).toBe("user-1");
  expect(payload.channel).toBe("chat:12345678-0000-4000-8000-000000000001");
  expect(payload.channels).toBeUndefined();
  expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
});
