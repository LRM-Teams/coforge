import { join } from "node:path";

import { bunChildEnv, bunExecutable } from "./local-bun";

const SERVER_ENTRY_RELATIVE = ".output/server/index.mjs";

/** Run the compiled Nitro production server. Requires `./scripts/build-prod.sh`. */
export async function runNitro(port: number): Promise<void> {
  const webRoot = join(import.meta.dir, "..");
  const serverEntry = join(webRoot, SERVER_ENTRY_RELATIVE);

  if (!(await Bun.file(serverEntry).exists())) {
    console.error(`Missing web production build (${SERVER_ENTRY_RELATIVE}).`);
    console.error("Run: ./scripts/build-prod.sh");
    process.exit(1);
  }

  console.log(`==> Starting production Nitro server on http://127.0.0.1:${port}`);

  const child = Bun.spawn([bunExecutable(), serverEntry], {
    cwd: webRoot,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: bunChildEnv({
      HOST: process.env.HOST?.trim() || "127.0.0.1",
      PORT: String(port),
      NODE_ENV: process.env.NODE_ENV?.trim() || "production",
    }),
  });

  process.exit(await child.exited);
}
