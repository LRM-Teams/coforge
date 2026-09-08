// Private E2E build: inject local transports at the module boundary, never through
// a runtime override in the publicly distributed CLI.
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const server = Bun.env.COFORGE_E2E_WEB_URL;
if (!server) throw new Error("COFORGE_E2E_WEB_URL is required");
const endpoint =
  Bun.env.COFORGE_E2E_CENTRIFUGO_ENDPOINT ?? "ws://127.0.0.1:8000/connection/websocket";

{
  const result = await Bun.build({
    entrypoints: [resolve(root, "packages/computer/src/main.ts")],
    compile: { outfile: resolve(root, ".amp/e2e/bin/coforge-computer") },
    plugins: [
      {
        name: "local-e2e-transports",
        setup(build) {
          build.onLoad({ filter: /\/computer\/src\/release-channel\.ts$/ }, () => ({
            contents: `export const COFORGE_SERVER_URL = ${JSON.stringify(server)};
            export const COFORGE_RELEASE_FEED_URL = "https://releases-staging.coforge.cn";`,
            loader: "ts",
          }));
          build.onLoad({ filter: /\/daemon\/src\/connection\/built-server\.ts$/ }, () => ({
            contents: `export const COFORGE_DAEMON_SERVER_URL = ${JSON.stringify(server)};
            export function daemonConnectionEndpoint() { return ${JSON.stringify(endpoint)}; }`,
            loader: "ts",
          }));
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, "E2E fixture compilation failed");
}
