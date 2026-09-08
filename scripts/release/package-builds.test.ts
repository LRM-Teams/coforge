import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const computerDirectory = join(REPO_ROOT, "packages/computer");
const daemonDirectory = join(REPO_ROOT, "packages/daemon");
const suffix = process.platform === "win32" ? ".exe" : "";
const computerBinary = join(computerDirectory, `dist/coforge-computer${suffix}`);
const previousBinaries = new Map<string, Uint8Array | null>();

beforeAll(async () => {
  for (const path of [computerBinary]) {
    const file = Bun.file(path);
    previousBinaries.set(
      path,
      (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : null,
    );
  }
});

afterAll(async () => {
  for (const [path, bytes] of previousBinaries) {
    if (bytes) await Bun.write(path, bytes);
    else await rm(path, { force: true });
  }
});

test.each([
  ["https://releases-staging.coforge.cn", "https://staging.coforge.cn"],
  ["https://releases.coforge.cn", "https://coforge.cn"],
])(
  "package builds use %s as the single Computer and Daemon environment",
  async (feedUrl, serverUrl) => {
    for (const cwd of [computerDirectory, daemonDirectory]) {
      const build = Bun.spawnSync([process.execPath, "run", "build"], {
        cwd,
        env: {
          ...Bun.env,
          COFORGE_RELEASE_FEED_URL: feedUrl,
          COFORGE_DAEMON_SERVER_URL: serverUrl.includes("staging")
            ? "https://coforge.cn"
            : "https://staging.coforge.cn",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(build.exitCode).toBe(0);
    }

    const computer = Bun.spawnSync([computerBinary, "--help"], {
      env: { ...Bun.env, COFORGE_RELEASE_FEED_URL: "https://invalid.example" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(computer.exitCode).toBe(0);
    expect(computer.stderr.toString()).toBe("");

    const state = await mkdtemp(join(tmpdir(), "coforge-package-build-"));
    try {
      const home = join(state, "home");
      const profileDirectory = join(home, ".coforge/computer");
      await mkdir(profileDirectory, { recursive: true });
      await Bun.write(
        join(profileDirectory, "profile.json"),
        JSON.stringify({
          server_url: serverUrl.includes("staging")
            ? "https://coforge.cn"
            : "https://staging.coforge.cn",
        }),
      );
      const login = Bun.spawnSync([computerBinary, "login"], {
        env: {
          ...Bun.env,
          HOME: home,
          HTTPS_PROXY: "http://127.0.0.1:1",
          https_proxy: "http://127.0.0.1:1",
          NO_PROXY: "",
          no_proxy: "",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });
      expect(login.exitCode).toBe(1);
      expect(login.stderr.toString()).toContain("AUTH_BUILD_ENVIRONMENT_MISMATCH");
      await Bun.write(
        join(state, "config.json"),
        JSON.stringify({
          computerId: "test-computer",
          workspaceId: "test-workspace",
          workspaceRoot: state,
          serverHttpUrl: serverUrl.includes("staging")
            ? "https://coforge.cn"
            : "https://staging.coforge.cn",
        }),
      );
      const daemon = Bun.spawnSync(
        [
          computerBinary,
          "__workspace-daemon",
          "--socket",
          join(state, "daemon.sock"),
          "--state-directory",
          state,
        ],
        {
          env: { ...Bun.env, HOME: join(state, "home") },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        },
      );
      expect(daemon.exitCode).toBe(1);
      expect(daemon.stderr.toString()).toContain("does not match this daemon build");
    } finally {
      await rm(state, { recursive: true, force: true });
    }

    const computerManifest = require(join(computerDirectory, "package.json"));
    const daemonManifest = require(join(daemonDirectory, "package.json"));
    expect(computerManifest.scripts.build).toContain("build-package.ts computer");
    expect(daemonManifest.scripts.build).toContain("build-package.ts daemon");
    expect(daemonManifest.scripts.build).not.toContain("COFORGE_DAEMON_SERVER_URL");
  },
  120_000,
);
