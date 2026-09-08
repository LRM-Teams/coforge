import { join, resolve } from "node:path";

import {
  resolveReleaseFeedUrl,
  resolveServerUrl,
} from "../../packages/computer/src/release-channel";

const REPO_ROOT = resolve(import.meta.dir, "../..");

const packageName = Bun.argv[2];
if (packageName !== "computer" && packageName !== "daemon") {
  throw new Error("usage: bun scripts/release/build-package.ts <computer|daemon>");
}

const feedUrl = resolveReleaseFeedUrl(Bun.env.COFORGE_RELEASE_FEED_URL);
const serverUrl = resolveServerUrl(feedUrl);
const packageDirectory = join(REPO_ROOT, "packages", packageName);
const manifest = await Bun.file(join(packageDirectory, "package.json")).json();
const entrypoint = join(packageDirectory, packageName === "computer" ? "src/main.ts" : "index.ts");
const outfile = join(packageDirectory, "dist", `coforge-${packageName}`);

const define =
  packageName === "computer"
    ? {
        "process.env.COFORGE_RELEASE_FEED_URL": JSON.stringify(feedUrl),
        "process.env.COFORGE_E2E_ALLOW_DEVICE_AUTH": JSON.stringify("0"),
        "Bun.env.COFORGE_COMPUTER_VERSION": JSON.stringify(manifest.version),
        "process.env.COFORGE_DAEMON_VERSION": JSON.stringify(manifest.version),
        "process.env.COFORGE_DAEMON_SERVER_URL": JSON.stringify(serverUrl),
      }
    : {
        "process.env.COFORGE_DAEMON_VERSION": JSON.stringify(manifest.version),
        "process.env.COFORGE_DAEMON_SERVER_URL": JSON.stringify(serverUrl),
      };

const result = await Bun.build({
  entrypoints: [entrypoint],
  ...(packageName === "computer"
    ? { compile: { outfile } }
    : { target: "bun" as const, outdir: join(packageDirectory, "dist") }),
  define,
});

if (!result.success) {
  throw new Error(result.logs.map(String).join("; "));
}
