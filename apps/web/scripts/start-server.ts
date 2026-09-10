import { DEFAULT_BACKEND_PORT, readListenPort } from "./listen-port";
import { runNitro } from "./run-nitro";

const port = readListenPort(process.env, DEFAULT_BACKEND_PORT);
await runNitro(port);
