import { join } from "node:path";

import { bunChildEnv, bunExecutable } from "./local-bun";
import { DEFAULT_BACKEND_PORT, readListenPort } from "./listen-port";

const port = readListenPort(process.env, DEFAULT_BACKEND_PORT);
const webRoot = join(import.meta.dir, "..");
const serverEntry = join(webRoot, ".output/server/index.mjs");

if (!(await Bun.file(serverEntry).exists())) {
  const build = Bun.spawn([bunExecutable(), "run", "build"], {
    cwd: webRoot,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: bunChildEnv(),
  });
  const buildStatus = await build.exited;
  if (buildStatus !== 0) process.exit(buildStatus);
}

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
