// Private E2E build: inject local transports at the module boundary, never through
// a runtime override in the publicly distributed CLI.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { zodResolvePlugin } from "../bun-resolve-zod-plugin";
import { resolvePhotonWasmBytes } from "../release/photon-wasm";

const root = resolve(import.meta.dir, "../..");
const server = Bun.env.COFORGE_E2E_WEB_URL;
if (!server) throw new Error("COFORGE_E2E_WEB_URL is required");
const endpoint =
  Bun.env.COFORGE_E2E_CENTRIFUGO_ENDPOINT ?? "ws://127.0.0.1:8000/connection/websocket";
const version = `0.0.0-e2e.${Date.now()}`;
const binDirectory = resolve(root, ".amp/e2e/bin");
await mkdir(binDirectory, { recursive: true });
// Bun's Windows compile appends `.exe` when the outfile has no extension; name the
// outfile with `.exe` up front so the path we read back matches what was written.
const binaryPath = resolve(
  binDirectory,
  process.platform === "win32" ? "coforge-computer.exe" : "coforge-computer",
);

{
  const result = await Bun.build({
    entrypoints: [resolve(root, "packages/computer/src/main.ts")],
    compile: { outfile: binaryPath },
    define: {
      "Bun.env.COFORGE_COMPUTER_VERSION": JSON.stringify(version),
      "process.env.COFORGE_DAEMON_VERSION": JSON.stringify(version),
      "process.env.COFORGE_E2E_ALLOW_DEVICE_AUTH": JSON.stringify("0"),
    },
    plugins: [
      zodResolvePlugin(root),
      {
        name: "local-e2e-transports",
        setup(build) {
          // Match both POSIX and Windows path separators; Bun on Windows passes
          // backslash paths that would miss a `/`-only filter and leave staging URLs baked in.
          build.onLoad({ filter: /(?:^|[\\/])computer[\\/]src[\\/]release-channel\.ts$/ }, () => ({
            contents: `export const COFORGE_SERVER_URL = ${JSON.stringify(server)};
            export const COFORGE_RELEASE_FEED_URL = "https://releases-staging.coforge.cn";`,
            loader: "ts",
          }));
          build.onLoad(
            { filter: /(?:^|[\\/])daemon[\\/]src[\\/]connection[\\/]built-server\.ts$/ },
            () => ({
              contents: `export const COFORGE_DAEMON_SERVER_URL = ${JSON.stringify(server)};
            export function daemonConnectionEndpoint() { return ${JSON.stringify(endpoint)}; }`,
              loader: "ts",
            }),
          );
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, "E2E fixture compilation failed");
}

// A host-platform test package, not a publishable six-platform release. Feed it
// through the same verified local-package installer used by bootstrap.
const directory = resolve(root, ".amp/e2e/native-package");
await mkdir(directory, { recursive: true });
const bytes = new Uint8Array(await Bun.file(binaryPath).arrayBuffer());
const gzip = Bun.gzipSync(bytes);
const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
if (commit.exitCode !== 0) throw new Error("Could not identify fixture source commit");
const photonWasm = await resolvePhotonWasmBytes();
await Bun.write(resolve(directory, "coforge-computer.gz"), gzip);
await Bun.write(resolve(directory, "photon_rs_bg.wasm"), photonWasm);
await Bun.write(
  resolve(directory, "manifest.json"),
  JSON.stringify({
    schema_version: 2,
    version,
    commit: commit.stdout.toString().trim(),
    buildDate: new Date().toISOString(),
    platforms: {
      [target]: {
        computer: {
          binary: "coforge-computer",
          size: bytes.byteLength,
          checksum: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
          gzip: {
            binary: "coforge-computer.gz",
            size: gzip.byteLength,
            checksum: new Bun.CryptoHasher("sha256").update(gzip).digest("hex"),
          },
        },
      },
    },
    photonWasm: {
      file: "photon_rs_bg.wasm",
      size: photonWasm.byteLength,
      checksum: new Bun.CryptoHasher("sha256").update(photonWasm).digest("hex"),
    },
  }),
);
