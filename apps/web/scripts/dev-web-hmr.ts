import { join } from "node:path";

import { bunChildEnv, bunExecutable } from "./local-bun";
import { DEFAULT_FRONTEND_PORT, readListenPort } from "./listen-port";

const port = readListenPort(process.env, DEFAULT_FRONTEND_PORT);
const webRoot = join(import.meta.dir, "..");

const child = Bun.spawn(
  [
    bunExecutable(),
    "--bun",
    "vite",
    "dev",
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
    "--strictPort",
  ],
  {
    cwd: webRoot,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: bunChildEnv({ PORT: String(port) }),
  },
);

process.exit(await child.exited);
