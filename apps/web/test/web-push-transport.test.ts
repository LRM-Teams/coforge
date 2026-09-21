import { mkdtemp, rm } from "node:fs/promises";
import { Agent } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import webPush from "web-push";

import { WebPushDeliveryError } from "../src/server/notifications/web-push-notifications.server";
import {
  createWebPushRequestDetails,
  readWebPushConfig,
  WebPushLibraryTransport,
} from "../src/server/notifications/web-push-transport.server";

const client = webPush.generateVAPIDKeys();
const subscription = {
  id: "subscription-a",
  endpoint: "https://fcm.googleapis.com/wp/subscription-a",
  p256dh: client.publicKey,
  auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
};
const payload = { title: "CoForge", body: "Ready", url: "/settings", tag: "test" };
const config = webPush.generateVAPIDKeys();
const webPushConfig = { subject: "https://coforge.cn", ...config };

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

test("WebPushLibraryTransport.send succeeds on a 2xx response", async () => {
  const transport = new WebPushLibraryTransport(
    webPushConfig,
    10_000,
    async () => new Agent(),
    async () => ({ statusCode: 201, body: "" }),
  );

  await expect(transport.send(subscription, payload)).resolves.toBeUndefined();
});

test("WebPushLibraryTransport.send maps a non-2xx response to WebPushDeliveryError(statusCode)", async () => {
  const transport = new WebPushLibraryTransport(
    webPushConfig,
    10_000,
    async () => new Agent(),
    async () => ({ statusCode: 410, body: "gone" }),
  );

  const error = await transport.send(subscription, payload).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(WebPushDeliveryError);
  expect((error as WebPushDeliveryError).statusCode).toBe(410);
});

test("WebPushLibraryTransport.send maps a network/timeout failure to WebPushDeliveryError(undefined)", async () => {
  const abortError = Object.assign(new Error("This operation was aborted"), {
    name: "AbortError",
  });
  const transport = new WebPushLibraryTransport(
    webPushConfig,
    10_000,
    async () => new Agent(),
    async () => {
      throw abortError;
    },
  );

  const error = await transport.send(subscription, payload).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(WebPushDeliveryError);
  expect((error as WebPushDeliveryError).statusCode).toBeUndefined();
});
