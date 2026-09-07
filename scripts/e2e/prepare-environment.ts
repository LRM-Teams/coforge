import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const directory = join(root, ".amp/e2e");
const path = join(directory, "worker-private.jwk");
const runtimeCredentialKeyPath = join(directory, "agent-runtime-credential-key");
const webPushPublicKeyPath = join(directory, "web-push-public-key");
const webPushPrivateKeyPath = join(directory, "web-push-private-key");

await mkdir(directory, { recursive: true });
if (!(await Bun.file(path).exists())) {
  const { privateKey } = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  await Bun.write(path, JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey)));
}
if (!(await Bun.file(runtimeCredentialKeyPath).exists())) {
  const key = crypto.getRandomValues(new Uint8Array(32));
  await Bun.write(
    runtimeCredentialKeyPath,
    [...key].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}
if (
  !(await Bun.file(webPushPublicKeyPath).exists()) ||
  !(await Bun.file(webPushPrivateKeyPath).exists())
) {
  const { privateKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const key = await crypto.subtle.exportKey("jwk", privateKey);
  if (!key.x || !key.y || !key.d) throw new Error("generated VAPID key is incomplete");
  const publicKey = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(key.x, "base64url"),
    Buffer.from(key.y, "base64url"),
  ]).toString("base64url");
  await Bun.write(webPushPublicKeyPath, publicKey);
  await Bun.write(webPushPrivateKeyPath, key.d);
  await chmod(webPushPrivateKeyPath, 0o600);
}
