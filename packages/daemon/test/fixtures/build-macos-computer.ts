import { join } from "node:path";

const [executable, serverUrl] = Bun.argv.slice(2);
const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "../../../computer/src/main.ts")],
  compile: { outfile: executable! },
  plugins: [
    {
      name: "private-mac-fixtures",
      setup(build) {
        build.onLoad({ filter: /\/connection\/daemon-connection\.ts$/ }, () => ({
          loader: "ts",
          contents: `export { DaemonConnection, defaultCentrifugeWorkspaceClientFactory } from ${JSON.stringify(join(import.meta.dir, "local-ready-connection.ts"))}`,
        }));
        build.onLoad({ filter: /\/connection\/built-server\.ts$/ }, () => ({
          loader: "ts",
          contents: `export const COFORGE_DAEMON_SERVER_URL=${JSON.stringify(serverUrl)}; export function daemonConnectionEndpoint(){return ${JSON.stringify(serverUrl!.replace("http:", "ws:"))}}`,
        }));
        build.onLoad({ filter: /\/code-agent\/runtime-inventory\.ts$/ }, () => ({
          loader: "ts",
          contents:
            "export async function discoverCodeAgentInventory(){return {runtimes:[],catalogs:[]}}",
        }));
      },
    },
  ],
});
if (!result.success) throw new Error(result.logs.map(String).join("\n"));
