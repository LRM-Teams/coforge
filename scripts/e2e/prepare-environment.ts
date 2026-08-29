import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const directory = join(root, ".amp/e2e");
const path = join(directory, "worker-private.jwk");

await mkdir(directory, { recursive: true });
if (!(await Bun.file(path).exists())) {
  const { privateKey } = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  await Bun.write(path, JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey)));
}
