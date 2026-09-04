import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

const script = resolve(import.meta.dir, "../../../install.sh");

/** Bun.spawnSync blocks the whole JS thread, including the fixture Bun.serve running in this
 * same process - a synchronous spawn here would deadlock the moment the script tries to reach
 * the fixture server. Bun.spawn keeps the event loop free so the fixture can respond. */
async function run(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn({ cmd: [script, ...args], env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, stderr };
}

function sha256hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Mirrors install.sh's own `uname -s`-`uname -m` switch, so the fixture serves the exact
 * target path the script under test will request. */
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

/** A PATH with jq's directory removed, so a test can exercise install.sh's bash-only regex
 * fallback. curl, uname, sed, tr, awk, chmod, and shasum/openssl still resolve from /usr and
 * /bin, so only the jq code path is disabled. */
function pathWithoutJq(): string {
  const jq = Bun.spawnSync({ cmd: ["which", "jq"] })
    .stdout.toString()
    .trim();
  const path = process.env.PATH ?? "";
  if (!jq) return path;
  const jqDirectory = jq.slice(0, jq.lastIndexOf("/"));
  return path
    .split(":")
    .filter((entry) => entry !== jqDirectory)
    .join(":");
}

/** Serves the four-object feed install.sh consumes: a "latest" pointer, one version's
 * manifest, and that version's computer binary for the target. The served binary is itself a
 * shell script that records the arguments it is invoked with, so the test can assert install.sh
 * chose the right version and forwarded it correctly. */
async function serveFixture(
  options: {
    version?: string;
    target?: string;
    tamperChecksum?: boolean;
    argumentLog?: string;
    omitPlatform?: boolean;
  } = {},
) {
  const version = options.version ?? "3.2.1";
  const target = options.target ?? currentTarget();
  const log = options.argumentLog ?? "/dev/null";
  const computer = Buffer.from(`#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\n`);
  const daemon = Buffer.from("#!/bin/sh\nexit 0\n");
  const checksum = options.tamperChecksum ? "0".repeat(64) : sha256hex(computer);

  const manifest = {
    schema_version: 1,
    version,
    commit: "b".repeat(40),
    buildDate: "2026-09-04T12:00:00Z",
    platforms: options.omitPlatform
      ? {}
      : {
          [target]: {
            computer: { binary: "coforge-computer", checksum, size: computer.length },
            daemon: {
              binary: "coforge-daemon",
              checksum: sha256hex(daemon),
              size: daemon.length,
            },
          },
        },
  };

  const files = new Map<string, Uint8Array>([
    ["/latest", Buffer.from(`${version}\n`)],
    [`/${version}/manifest.json`, Buffer.from(JSON.stringify(manifest))],
    [`/${version}/${target}/coforge-computer`, computer],
    [`/${version}/${target}/coforge-daemon`, daemon],
  ]);

  const requested: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requested.push(path);
      const bytes = files.get(path);
      return bytes ? new Response(Buffer.from(bytes)) : new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { baseUrl: `http://localhost:${server.port}`, version, target, requested };
}

for (const withoutJq of [false, true] as const) {
  test(`install.sh resolves latest and an explicit version${withoutJq ? " without jq" : " with jq"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "coforge-install-script-"));
    temporaryDirectories.push(directory);
    const log = join(directory, "arguments");

    for (const selector of ["latest", "3.2.1"] as const) {
      const fixture = await serveFixture({ argumentLog: log });
      const child = await run(["--version", selector], {
        ...process.env,
        ...(withoutJq ? { PATH: pathWithoutJq() } : {}),
        COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
        COFORGE_INSTALLER_TEST_MODE: "1",
      });
      expect(child.exitCode).toBe(0);
      expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
        "install",
        "--version",
        "3.2.1",
      ]);
      // Only the computer binary is fetched; install.sh's own job ends at exec-ing it, and the
      // exec'd binary's own `install` command is what fetches the daemon payload.
      expect(fixture.requested).not.toContain(
        `/${fixture.version}/${fixture.target}/coforge-daemon`,
      );
    }

    const omitted = await run([], {
      ...process.env,
      ...(withoutJq ? { PATH: pathWithoutJq() } : {}),
      COFORGE_RELEASE_FEED_URL: (await serveFixture({ argumentLog: log })).baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    });
    expect(omitted.exitCode).toBe(0);
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "install",
      "--version",
      "3.2.1",
    ]);
  });
}

for (const withoutJq of [false, true] as const) {
  test(`install.sh reports a missing platform entry the same way${withoutJq ? " without jq" : " with jq"}`, async () => {
    const fixture = await serveFixture({ omitPlatform: true });

    const child = await run(["--version", "latest"], {
      ...process.env,
      ...(withoutJq ? { PATH: pathWithoutJq() } : {}),
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    });

    expect(child.exitCode).not.toBe(0);
    expect(child.stderr).toContain("no computer entry");
  });
}

test("install.sh rejects a downloaded binary that fails its manifest checksum", async () => {
  const fixture = await serveFixture({ tamperChecksum: true });

  const child = await run(["--version", "latest"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });

  expect(child.exitCode).not.toBe(0);
  expect(child.stderr).toContain("checksum");
});

test("install.sh rejects an unparsable version before making any request", async () => {
  const child = await run(["--version", "../etc/passwd"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: "http://localhost:1",
  });

  expect(child.exitCode).not.toBe(0);
  expect(child.stderr).toContain("version must be");
});

test("install.sh refuses a plain-HTTP feed outside test mode", async () => {
  const child = await run(["--version", "latest"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: "http://localhost:1",
  });

  expect(child.exitCode).not.toBe(0);
  expect(child.stderr).toContain("HTTPS");
});

test("install scripts fail closed and stay within the current user's own account", async () => {
  const shell = await readFile(resolve(import.meta.dir, "../../../install.sh"), "utf8");
  const powershell = await readFile(resolve(import.meta.dir, "../../../install.ps1"), "utf8");

  expect(shell).not.toContain("sudo");
  expect(shell).not.toContain("/usr/local");
  expect(powershell).not.toContain("Program Files");
  expect(powershell).not.toContain("Start-Process -Verb RunAs");
  // Neither installer pins a checksum for any published object: every payload is verified
  // against the checksum the feed's own manifest.json names at install time.
  expect(shell).not.toMatch(/[0-9a-f]{64}/);
  expect(powershell).not.toMatch(/[0-9a-f]{64}/);
  expect(shell).toContain("HTTPS");
  expect(powershell).toContain("HTTPS");
});
