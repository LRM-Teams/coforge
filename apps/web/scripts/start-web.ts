import { DEFAULT_FRONTEND_PORT, readListenPort } from "./listen-port";
import { runNitro } from "./run-nitro";

const port = readListenPort(process.env, DEFAULT_FRONTEND_PORT);
await runNitro(port);
