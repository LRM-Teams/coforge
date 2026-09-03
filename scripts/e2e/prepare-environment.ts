import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const directory = join(root, ".amp/e2e");
const path = join(directory, "worker-private.jwk");
const runtimeCredentialKeyPath = join(directory, "agent-runtime-credential-key");

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
