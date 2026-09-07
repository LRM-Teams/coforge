import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import webPush from "web-push";

import {
  createWebPushRequestDetails,
  readWebPushConfig,
} from "../src/server/notifications/web-push-transport.server";

test("rejects a VAPID public key that does not match the private key", async () => {
  const first = webPush.generateVAPIDKeys();
  const second = webPush.generateVAPIDKeys();
  const directory = await mkdtemp(join(tmpdir(), "coforge-vapid-"));
  const privateKeyFile = join(directory, "private-key");
  try {
    await Bun.write(privateKeyFile, first.privateKey);
    await expect(
      readWebPushConfig({
        COFORGE_WEB_PUSH_PUBLIC_KEY: second.publicKey,
        COFORGE_WEB_PUSH_PRIVATE_KEY_FILE: privateKeyFile,
      }),
    ).rejects.toThrow("Web Push public and private keys do not match");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("web-push 3.6.7 creates an encrypted aes128gcm request under Bun", async () => {
  const vapid = webPush.generateVAPIDKeys();
  const client = webPush.generateVAPIDKeys();
  const details = await createWebPushRequestDetails(
    {
      subject: "https://coforge.cn",
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    },
    {
      id: "subscription-a",
      endpoint: "https://fcm.googleapis.com/wp/subscription-a",
      p256dh: client.publicKey,
      auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
    },
    {
      title: "CoForge",
      body: "Encrypted payload",
      url: "/settings",
      tag: "test",
    },
  );

  expect(details.headers["Content-Encoding"]).toBe("aes128gcm");
  expect(details.headers.Authorization).toStartWith("vapid ");
  expect(Buffer.isBuffer(details.body)).toBeTrue();
  expect(details.body?.toString()).not.toContain("Encrypted payload");
});
