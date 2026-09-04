import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ComputerUpdater } from "../../packages/computer/src/updater";
import { buildReleaseTree, isValidReleaseVersion, type ReleaseInputs } from "./build-release";

// Core acceptance: the feed tree buildReleaseTree() produces must be accepted, byte-for-byte, by
// both real consumers - packages/computer/src/updater.ts (imported directly) and the real
// scripts/release/install.sh (spawned as a subprocess). Both are exercised against small fake
// binaries (a shell script, a plain string) rather than a real compile, which is slow and
// intentionally out of scope here - see compile-targets.ts.

const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Mirrors install.sh's own `uname -s`-`uname -m` switch (see packages/computer/test/
 * installer-scripts.test.ts), so the host-target fixture below matches the platform the real
 * install.sh spawn will actually detect. */
function currentTarget(): string {
  const system = Bun.spawnSync({ cmd: ["uname", "-s"] })
    .stdout.toString()
    .trim();
  const machine = Bun.spawnSync({ cmd: ["uname", "-m"] })
    .stdout.toString()
    .trim();
  const targets: Record<string, string> = {
    "Linux-x86_64": "linux-x64",
    "Linux-aarch64": "linux-arm64",
    "Linux-arm64": "linux-arm64",
    "Darwin-x86_64": "darwin-x64",
    "Darwin-arm64": "darwin-arm64",
  };
  const target = targets[`${system}-${machine}`];
  if (!target) throw new Error(`unsupported test platform: ${system}-${machine}`);
  return target;
}

const ALL_TARGETS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "windows-x64",
  "windows-arm64",
];

/** Every target gets its own, distinct computer and daemon bytes (the target name is embedded in
 * both). Identical bytes across targets would let a "wrote target A's checksum into target B's
 * sidecar" bug pass the consistency test further down - only distinct bytes make that a real
 * check. Each computer "binary" is a runnable POSIX shell script, since the install.sh test below
 * executes whichever one matches the current host platform. `argumentLog` is where it records the
 * arguments it was invoked with; tests that never execute a binary can pass "/dev/null". */
function fixtureArtifacts(
  argumentLog: string,
): Record<string, { computer: Uint8Array; daemon: Uint8Array }> {
  const artifacts: Record<string, { computer: Uint8Array; daemon: Uint8Array }> = {};
  for (const target of ALL_TARGETS) {
    artifacts[target] = {
      computer: Buffer.from(
        `#!/bin/sh\n# release target: ${target}\nprintf '%s\\n' "$@" > "${argumentLog}"\n`,
      ),
      daemon: Buffer.from(`daemon-payload-${target}\n`),
    };
  }
  return artifacts;
}

function releaseInputs(overrides: Partial<ReleaseInputs> = {}): ReleaseInputs {
  return {
    version: overrides.version ?? "3.2.1",
    commit: overrides.commit ?? "a".repeat(40),
    buildDate: overrides.buildDate ?? "2026-09-04T12:00:00Z",
    artifacts: overrides.artifacts ?? fixtureArtifacts("/dev/null"),
  };
}

/** Serves a built tree exactly the way a real feed would: the object at each requested path,
 * verbatim bytes, no redirects, 404 for anything not on disk. `latest` is written by the caller,
 * never by buildReleaseTree - see the "never writes latest" test below. */
function serveTree(root: string) {
  const requested: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      requested.push(pathname);
      const file = Bun.file(join(root, pathname));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file);
    },
  });
  servers.push(server);
  return { baseUrl: `http://localhost:${server.port}`, requested };
}

/** Flips one hex character to a *different* valid hex character, so the mutated value still
 * matches updater.ts's CHECKSUM_PATTERN (/^[0-9a-f]{64}$/) and install.sh's own hex `case`
 * pattern. That is what makes this a checksum-mismatch test rather than a malformed-value test:
 * both consumers have a separate, earlier rejection for a sidecar/checksum that isn't 64 lowercase
 * hex characters at all, which is not what this is meant to exercise. */
function flipHexChar(hex: string, index: number): string {
  const alphabet = "0123456789abcdef";
  const current = hex[index]!;
  const next = alphabet[(alphabet.indexOf(current) + 1) % alphabet.length]!;
  return hex.slice(0, index) + next + hex.slice(index + 1);
}

async function runInstallSh(baseUrl: string): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn({
    cmd: [join(import.meta.dir, "install.sh"), "--version", "latest"],
    env: { ...process.env, COFORGE_RELEASE_FEED_URL: baseUrl, COFORGE_INSTALLER_TEST_MODE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, stderr };
}

test("version validation matches updater.ts's and both installers' isValidVersion/is_valid_version rule", () => {
  const accepted = ["3.2.1", "0.1.0-alpha.1", "1.0.0+build.5", "a", "9".repeat(100)];
  const rejected = [
    "",
    ".",
    "..",
    "-rf",
    "-1.0.0",
    "a/b",
    "a..b",
    "1.0.0..2",
    "9".repeat(101),
    "has space",
  ];
  for (const version of accepted) expect(isValidReleaseVersion(version)).toBe(true);
  for (const version of rejected) expect(isValidReleaseVersion(version)).toBe(false);
});

test("buildReleaseTree rejects an invalid version before writing anything to disk", async () => {
  const outputDirectory = await tempDir("coforge-release-tree-");
  for (const invalid of [".", "..", "-rf", "a/b", ""]) {
    await expect(
      buildReleaseTree(releaseInputs({ version: invalid }), outputDirectory),
    ).rejects.toThrow(/version/);
  }
  expect(await readdir(outputDirectory)).toEqual([]);
});

test("buildReleaseTree writes the full <version>/ tree and never a latest pointer", async () => {
  const outputDirectory = await tempDir("coforge-release-tree-");
  const inputs = releaseInputs();

  const result = await buildReleaseTree(inputs, outputDirectory);

  expect(result.version).toBe(inputs.version);
  expect(result.files).toEqual([...result.files].sort());
  expect(result.files.every((file) => !file.includes("\\") && !file.startsWith("/"))).toBe(true);
  // Publishing "latest" is the last step of the (not-yet-built) publish workflow, not of a build:
  // it must not appear in the returned file list, and no "latest" object may exist on disk.
  expect(result.files).not.toContain("latest");
  expect(result.files.some((file) => file.endsWith("/latest"))).toBe(false);
  expect(await readdir(outputDirectory)).toEqual([inputs.version]);
  await expect(stat(join(outputDirectory, "latest"))).rejects.toThrow();

  for (const target of ALL_TARGETS) {
    expect(result.files).toContain(`${inputs.version}/${target}/coforge-computer`);
    expect(result.files).toContain(`${inputs.version}/${target}/coforge-computer.sha256`);
    expect(result.files).toContain(`${inputs.version}/${target}/coforge-daemon`);
  }
  expect(result.files).toContain(`${inputs.version}/manifest.json`);
});

test("every target's sidecar checksum matches the manifest's checksum, and both match an independently recomputed sha256 of the bytes on disk", async () => {
  const outputDirectory = await tempDir("coforge-release-tree-");
  const inputs = releaseInputs();

  const { version } = await buildReleaseTree(inputs, outputDirectory);
  const manifest = JSON.parse(
    await readFile(join(outputDirectory, version, "manifest.json"), "utf8"),
  );

  for (const target of ALL_TARGETS) {
    const computerBytes = await readFile(
      join(outputDirectory, version, target, "coforge-computer"),
    );
    // Recomputed here, independently, from the bytes actually on disk - not compared against
    // either of the two values buildReleaseTree itself produced.
    const independentChecksum = sha256hex(computerBytes);

    const sidecar = (
      await readFile(join(outputDirectory, version, target, "coforge-computer.sha256"), "utf8")
    ).trim();
    expect(sidecar).toBe(independentChecksum);
    expect(manifest.platforms[target].computer.checksum).toBe(independentChecksum);
    expect(manifest.platforms[target].computer.size).toBe(computerBytes.byteLength);
    expect(manifest.platforms[target].computer.binary).toBe("coforge-computer");
    expect(manifest.platforms[target].daemon.binary).toBe("coforge-daemon");
  }
});

test("ComputerUpdater installs successfully from the produced tree, for every release target", async () => {
  const outputDirectory = await tempDir("coforge-release-tree-");
  const inputs = releaseInputs();
  const { version } = await buildReleaseTree(inputs, outputDirectory);
  await writeFile(join(outputDirectory, "latest"), `${version}\n`);
  const { baseUrl } = serveTree(outputDirectory);

  for (const target of ALL_TARGETS) {
    const installRoot = await tempDir("coforge-updater-install-");
    const updater = new ComputerUpdater({ baseUrl, target, installRoot });

    const result = await updater.install("latest");

    expect(result.version).toBe(version);
    const suffix = target.startsWith("windows-") ? ".exe" : "";
    const installedComputer = await readFile(
      join(installRoot, "versions", version, `coforge-computer${suffix}`),
    );
    const installedDaemon = await readFile(
      join(installRoot, "versions", version, `coforge-daemon${suffix}`),
    );
    expect(installedComputer.equals(Buffer.from(inputs.artifacts[target]!.computer))).toBe(true);
    expect(installedDaemon.equals(Buffer.from(inputs.artifacts[target]!.daemon))).toBe(true);
  }
});

test("the real install.sh installs successfully from the produced tree", async () => {
  const directory = await tempDir("coforge-install-sh-");
  const log = join(directory, "arguments");
  const outputDirectory = await tempDir("coforge-release-tree-");
  const host = currentTarget();
  // Only the host target's binary is ever actually executed, so only it needs a real log path;
  // every other target keeps the /dev/null default from fixtureArtifacts.
  const artifacts = fixtureArtifacts("/dev/null");
  artifacts[host] = {
    computer: Buffer.from(`#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\n`),
    daemon: artifacts[host]!.daemon,
  };
  const { version } = await buildReleaseTree(releaseInputs({ artifacts }), outputDirectory);
  await writeFile(join(outputDirectory, "latest"), `${version}\n`);
  const { baseUrl } = serveTree(outputDirectory);

  const { exitCode, stderr } = await runInstallSh(baseUrl);

  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
    "install",
    "--version",
    version,
  ]);
});

test("install.sh fails when one bit of a sidecar checksum is flipped", async () => {
  const outputDirectory = await tempDir("coforge-release-tree-");
  const host = currentTarget();
  const { version } = await buildReleaseTree(releaseInputs(), outputDirectory);
  await writeFile(join(outputDirectory, "latest"), `${version}\n`);

  const sidecarPath = join(outputDirectory, version, host, "coforge-computer.sha256");
  const original = (await readFile(sidecarPath, "utf8")).trim();
  await writeFile(sidecarPath, `${flipHexChar(original, 0)}\n`);
  const { baseUrl } = serveTree(outputDirectory);

  const { exitCode, stderr } = await runInstallSh(baseUrl);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("failed its checksum check");
});

test("ComputerUpdater rejects a tree whose manifest checksum was tampered with, with UPDATE_INTEGRITY_FAILED", async () => {
  const outputDirectory = await tempDir("coforge-release-tree-");
  const target = ALL_TARGETS[0]!;
  const { version } = await buildReleaseTree(releaseInputs(), outputDirectory);
  await writeFile(join(outputDirectory, "latest"), `${version}\n`);

  const manifestPath = join(outputDirectory, version, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.platforms[target].computer.checksum = flipHexChar(
    manifest.platforms[target].computer.checksum,
    0,
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const { baseUrl } = serveTree(outputDirectory);
  const installRoot = await tempDir("coforge-updater-install-");
  const updater = new ComputerUpdater({ baseUrl, target, installRoot });

  await expect(updater.install("latest")).rejects.toMatchObject({
    code: "UPDATE_INTEGRITY_FAILED",
  });
});
