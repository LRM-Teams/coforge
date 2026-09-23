import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

/** The exact file name docs/release/local-distribution.md's feed layout and
 * packages/computer/src/updater.ts's manifest.photonWasm.file both pin - never "some safe
 * filename". */
export const PHOTON_WASM_FILE = "photon_rs_bg.wasm";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const AGENT_PACKAGE_DIRECTORY = resolve(REPO_ROOT, "packages/agent");

/** Resolves the exact `photon_rs_bg.wasm` bytes Pi's own image-resize code loads at runtime -
 * not a copy this repository vendors or pins a version for separately. Pi (`@earendil-works/
 * pi-coding-agent`, a `packages/agent` dependency) depends on `@silvia-odwyer/photon-node`,
 * whose package directory ships the wasm file next to its `package.json`; walking that exact
 * dependency chain (rather than a fixed `node_modules/.bun/...` path) is what keeps this resolver
 * correct across package-manager layout changes and version bumps of either package.
 *
 * `fromDirectory` lets tests point resolution at a fixture tree instead of the real installed
 * dependency. */
export async function resolvePhotonWasmBytes(
  fromDirectory: string = AGENT_PACKAGE_DIRECTORY,
): Promise<Uint8Array> {
  const require = createRequire(`${fromDirectory}/`);
  const piPackageJson = require.resolve("@earendil-works/pi-coding-agent/package.json", {
    paths: [fromDirectory],
  });
  const photonPackageJson = require.resolve("@silvia-odwyer/photon-node/package.json", {
    paths: [dirname(piPackageJson)],
  });
  const wasmPath = resolve(dirname(photonPackageJson), PHOTON_WASM_FILE);
  return new Uint8Array(await Bun.file(wasmPath).arrayBuffer());
}
