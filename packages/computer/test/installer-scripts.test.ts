import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

const script = resolve(import.meta.dir, "../../../scripts/release/install.sh");

/** Bun.spawnSync blocks the whole JS thread, including the fixture Bun.serve running in this
 * same process - a synchronous spawn here would deadlock the moment the script tries to reach
 * the fixture server. Bun.spawn keeps the event loop free so the fixture can respond. */
async function run(
  args: string[],
  env: Record<string, string | undefined>,
  isolatedHome?: string,
  shellRoots: { zdotdir?: string; xdgConfigHome?: string } = {},
): Promise<{ exitCode: number; stderr: string; home: string }> {
  // Every installer execution gets a disposable HOME. This is a safety boundary, not just test
  // cleanup: behavior tests exercise shell startup-file persistence and must never append to the
  // developer's real shell configuration, even when callers spread process.env.
  const home = isolatedHome ?? (await mkdtemp(join(tmpdir(), "coforge-installer-home-")));
  if (!isolatedHome) temporaryDirectories.push(home);
  const child = Bun.spawn({
    cmd: [script, ...args],
    env: {
      ...env,
      HOME: home,
      ZDOTDIR: shellRoots.zdotdir ?? home,
      XDG_CONFIG_HOME: shellRoots.xdgConfigHome ?? join(home, ".config"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, stderr, home };
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

/** Serves the two objects install.sh consumes for a version: a sidecar checksum file
 * (`<version>/<target>/coforge-computer.sha256`, a bare hex line - no manifest.json, no jq, no
 * sed-based JSON parsing) and that version's computer binary. Also serves "/latest". The served
 * binary is itself a shell script that records the arguments it is invoked with, so a test can
 * assert install.sh chose the right version and forwarded it correctly. */
async function serveFixture(
  options: {
    version?: string;
    target?: string;
    tamperChecksum?: boolean;
    argumentLog?: string;
    omitSidecar?: boolean;
    omitGzip?: boolean;
    gzipStatus?: number;
    corruptGzip?: boolean;
    latestContent?: string;
  } = {},
) {
  const version = options.version ?? "3.2.1";
  const target = options.target ?? currentTarget();
  const log = options.argumentLog ?? "/dev/null";
  const computer = Buffer.from(`#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\n`);
  const checksum = options.tamperChecksum ? "0".repeat(64) : sha256hex(computer);

  const files = new Map<string, Uint8Array>([
    ["/latest", Buffer.from(options.latestContent ?? `${version}\n`)],
  ]);
  if (!options.omitGzip) {
    files.set(
      `/${version}/${target}/coforge-computer.gz`,
      options.corruptGzip ? Buffer.from("not gzip") : Bun.gzipSync(computer),
    );
  }
  if (!options.omitSidecar) {
    files.set(`/${version}/${target}/coforge-computer.sha256`, Buffer.from(`${checksum}\n`));
  }

  const requested: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requested.push(path);
      if (path.endsWith("/coforge-computer.gz") && options.gzipStatus) {
        return new Response("failure", { status: options.gzipStatus });
      }
      const bytes = files.get(path);
      return bytes ? new Response(Buffer.from(bytes)) : new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { baseUrl: `http://localhost:${server.port}`, version, target, requested };
}

test("install.sh resolves latest and an explicit version, and never touches manifest.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-install-script-"));
  temporaryDirectories.push(directory);
  const log = join(directory, "arguments");

  for (const selector of ["latest", "3.2.1"] as const) {
    const fixture = await serveFixture({ argumentLog: log });
    const child = await run(["--version", selector], {
      ...process.env,
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    });
    expect(child.exitCode).toBe(0);
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "install",
      "--version",
      "3.2.1",
    ]);
    // Only the computer binary and its sidecar checksum are fetched; install.sh no longer
    // downloads or parses manifest.json at all (B1), and its own job ends at running the
    // computer binary - that binary's own `install` command is what fetches the daemon payload.
    expect(fixture.requested).not.toContain(`/${fixture.version}/manifest.json`);
    expect(fixture.requested).not.toContain(`/${fixture.version}/${fixture.target}/coforge-daemon`);
    expect(fixture.requested).toContain(
      `/${fixture.version}/${fixture.target}/coforge-computer.gz`,
    );
    expect(fixture.requested).not.toContain(
      `/${fixture.version}/${fixture.target}/coforge-computer`,
    );
  }

  const omitted = await run([], {
    ...process.env,
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

test("install.sh fails on gzip HTTP 404 without requesting a raw binary", async () => {
  const missingGzip = await serveFixture({ omitGzip: true });
  const child = await run(["--version", missingGzip.version], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: missingGzip.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(child.exitCode).not.toBe(0);
  expect(missingGzip.requested).not.toContain(
    `/${missingGzip.version}/${missingGzip.target}/coforge-computer`,
  );
});

for (const options of [{ corruptGzip: true }, { gzipStatus: 500 }]) {
  test(`install.sh fails closed without raw fallback for ${JSON.stringify(options)}`, async () => {
    const fixture = await serveFixture(options);
    const child = await run(["--version", fixture.version], {
      ...process.env,
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    });
    expect(child.exitCode).not.toBe(0);
    expect(fixture.requested).not.toContain(
      `/${fixture.version}/${fixture.target}/coforge-computer`,
    );
  });
}

test("install.sh fails closed when the sidecar checksum is missing", async () => {
  const fixture = await serveFixture({ omitSidecar: true });

  const child = await run(["--version", "latest"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });

  expect(child.exitCode).not.toBe(0);
  expect(fixture.requested).not.toContain(`/${fixture.version}/${fixture.target}/coforge-computer`);
});

test("install.sh rejects a downloaded binary that fails its sidecar checksum", async () => {
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

test("install.sh rejects '.' and a version starting with '-' before making any request", async () => {
  for (const invalid of [".", "-rf"]) {
    const child = await run(["--version", invalid], {
      ...process.env,
      COFORGE_RELEASE_FEED_URL: "http://localhost:1",
    });
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr).toContain("version must be");
  }
});

test("install.sh refuses a plain-HTTP feed outside test mode", async () => {
  const child = await run(["--version", "latest"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: "http://localhost:1",
  });

  expect(child.exitCode).not.toBe(0);
  expect(child.stderr).toContain("HTTPS");
});

test("install.sh clearly reports when gzip is unavailable", async () => {
  const emptyPath = await mkdtemp(join(tmpdir(), "coforge-empty-path-"));
  temporaryDirectories.push(emptyPath);
  const child = await run(["--version", "3.2.1"], {
    PATH: emptyPath,
    COFORGE_RELEASE_FEED_URL: "https://releases.example.test",
  });

  expect(child.exitCode).not.toBe(0);
  expect(child.stderr).toContain("gzip is required");
});

const invalidLatestPointers: Array<[name: string, content: string]> = [
  ["an HTML error page", "<html><body>502 Bad Gateway</body></html>"],
  ["content containing a traversal segment", ".."],
  ["an empty body", ""],
];

for (const [name, latestContent] of invalidLatestPointers) {
  test(`install.sh fails closed and never fetches the binary when the latest pointer returns ${name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "coforge-install-script-"));
    temporaryDirectories.push(directory);
    const log = join(directory, "arguments");
    const fixture = await serveFixture({ latestContent, argumentLog: log });

    const child = await run(["--version", "latest"], {
      ...process.env,
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    });

    expect(child.exitCode).not.toBe(0);
    // Pin the exact message: without this, is_valid_version() being stubbed to always succeed
    // would still fail closed for most of these bodies (they do not form a URL segment the
    // fixture recognizes, so the next download 404s) but with a different, unrelated error -
    // which would let the test keep passing even though the check under test was disabled.
    expect(child.stderr).toContain("install.sh: the latest pointer did not return a valid version");
    expect(fixture.requested).not.toContain(
      `/${fixture.version}/${fixture.target}/coforge-computer`,
    );
    await expect(readFile(log, "utf8")).rejects.toThrow();
  });
}

test("install.sh caps the size of the latest pointer and sidecar downloads", async () => {
  // Both objects are tiny, feed-controlled text - "latest" has no advertised size at all, and
  // the sidecar's is a single 64-character checksum line - so a response well past the 4096-byte
  // cap must be rejected before the script trusts any of it (N4). curl checks a declared
  // Content-Length against `--max-filesize` before downloading, so this does not require
  // actually streaming an unbounded body to prove the cap is enforced.
  //
  // Pin curl's own "(63)" exit signal, not just a nonzero exit code: 5000 bytes of "a" is also
  // rejected without the cap - it fails is_valid_version()'s length check as a "latest" pointer,
  // and its length simply does not equal 64 as a sidecar checksum - so asserting only a nonzero
  // exit would still pass with --max-filesize removed entirely, for the wrong reason.
  const version = "3.2.1";
  const target = currentTarget();
  const oversized = Buffer.alloc(5000, 0x61);
  const files = new Map<string, Uint8Array>([
    ["/latest", oversized],
    [`/${version}/${target}/coforge-computer.sha256`, oversized],
  ]);
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const bytes = files.get(new URL(request.url).pathname);
      return bytes ? new Response(Buffer.from(bytes)) : new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const feedUrl = `http://localhost:${server.port}`;

  const latestChild = await run(["--version", "latest"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: feedUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(latestChild.exitCode).not.toBe(0);
  expect(latestChild.stderr).toContain("curl: (63)");

  const sidecarChild = await run(["--version", version], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: feedUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(sidecarChild.exitCode).not.toBe(0);
  expect(sidecarChild.stderr).toContain("curl: (63)");
});

test("install.sh removes its temporary directory after a successful install instead of exec-leaking it", async () => {
  // Regression test for N1: `exec`-ing the computer binary replaces this shell process, so the
  // `trap ... EXIT` cleanup never runs and the ~138 MB binary is left behind in $TMPDIR on every
  // install. Point $TMPDIR at an empty, dedicated directory and assert it is empty again once
  // the script (which runs the binary as an ordinary child, not via exec) exits successfully.
  const testTmpDir = await mkdtemp(join(tmpdir(), "coforge-tmpdir-"));
  temporaryDirectories.push(testTmpDir);
  const fixture = await serveFixture();

  const child = await run(["--version", "latest"], {
    ...process.env,
    TMPDIR: testTmpDir,
    COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });

  expect(child.exitCode).toBe(0);
  expect(await readdir(testTmpDir)).toEqual([]);
});

test("installer test helper never uses inherited shell configuration roots", async () => {
  const fixture = await serveFixture();
  const external = await mkdtemp(join(tmpdir(), "coforge-external-shell-"));
  temporaryDirectories.push(external);
  await mkdir(join(external, "fish/conf.d"), { recursive: true });
  for (const path of [join(external, ".zshrc"), join(external, "fish/conf.d/coforge.fish")]) {
    await Bun.write(path, "# sentinel\n");
  }
  for (const shell of ["zsh", "fish"]) {
    const result = await run(["--version", fixture.version], {
      ...process.env,
      SHELL: `/usr/bin/${shell}`,
      ZDOTDIR: external,
      XDG_CONFIG_HOME: external,
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    });
    expect(result.exitCode).toBe(0);
  }
  expect(await Bun.file(join(external, ".zshrc")).text()).toBe("# sentinel\n");
  expect(await Bun.file(join(external, "fish/conf.d/coforge.fish")).text()).toBe("# sentinel\n");
});

for (const shell of ["bash", "zsh", "fish"] as const) {
  test(`install.sh preserves and idempotently updates ${shell} PATH configuration`, async () => {
    const fixture = await serveFixture();
    const xdg = await mkdtemp(join(tmpdir(), "coforge-xdg-"));
    const zdot = await mkdtemp(join(tmpdir(), "coforge-zdot-"));
    temporaryDirectories.push(xdg, zdot);
    const first = await run(
      ["--version", fixture.version],
      {
        ...process.env,
        SHELL: `/usr/bin/${shell}`,
        XDG_CONFIG_HOME: xdg,
        ZDOTDIR: zdot,
        COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
        COFORGE_INSTALLER_TEST_MODE: "1",
      },
      undefined,
      { zdotdir: zdot, xdgConfigHome: xdg },
    );
    expect(first.exitCode).toBe(0);

    const configuration =
      shell === "fish"
        ? join(xdg, "fish/conf.d/coforge.fish")
        : shell === "zsh"
          ? join(zdot, ".zshrc")
          : join(first.home, ".bashrc");
    const original = "# existing user configuration";
    // Put existing content before a repeated install to prove it is preserved rather than
    // replacing the startup file. The first install's PATH line must remain singular too.
    const firstContent = await readFile(configuration, "utf8");
    await Bun.write(configuration, `${original}\n${firstContent}`);

    const second = await run(
      ["--version", fixture.version],
      {
        ...process.env,
        SHELL: `/usr/bin/${shell}`,
        XDG_CONFIG_HOME: xdg,
        ZDOTDIR: zdot,
        COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
        COFORGE_INSTALLER_TEST_MODE: "1",
      },
      first.home,
      { zdotdir: zdot, xdgConfigHome: xdg },
    );
    const secondConfiguration = configuration;
    expect(second.exitCode).toBe(0);
    const content = await readFile(secondConfiguration, "utf8");
    const pathLine =
      shell === "fish"
        ? 'fish_add_path "$HOME/.coforge/computer/bin"'
        : 'export PATH="$HOME/.coforge/computer/bin:$PATH"';
    expect(content).toContain(original);
    expect(content.split(pathLine)).toHaveLength(2);
    expect(first.stderr).toContain("This installer cannot change the current shell");
    expect(first.stderr).toContain('"$HOME/.coforge/computer/bin/coforge-computer" setup');
    if (shell === "bash") {
      const loginProfile = await readFile(join(first.home, ".bash_profile"), "utf8");
      expect(loginProfile.split(pathLine)).toHaveLength(2);
    }

    const shellExecutable = Bun.which(shell);
    if (shellExecutable) {
      const installedBin = join(first.home, ".coforge/computer/bin");
      await mkdir(installedBin, { recursive: true });
      const installedExecutable = join(installedBin, "coforge-computer");
      await Bun.write(installedExecutable, "#!/bin/sh\nexit 0\n");
      await Bun.spawn({ cmd: ["chmod", "700", installedExecutable] }).exited;
      const shellArgs =
        shell === "bash"
          ? ["--noprofile", "--rcfile", configuration, "-i", "-c", "command -v coforge-computer"]
          : ["-i", "-c", "command -v coforge-computer"];
      const freshShell = Bun.spawn({
        cmd: [shellExecutable, ...shellArgs],
        env: {
          ...process.env,
          HOME: first.home,
          ZDOTDIR: zdot,
          XDG_CONFIG_HOME: xdg,
        },
        stdout: "pipe",
        stderr: "ignore",
      });
      const [exitCode, stdout] = await Promise.all([
        freshShell.exited,
        new Response(freshShell.stdout).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe(installedExecutable);
    }
  });
}

test("install.sh reports PATH persistence failure and does not claim install success", async () => {
  const fixture = await serveFixture();
  const notDirectory = join(await mkdtemp(join(tmpdir(), "coforge-zdot-file-")), "file");
  temporaryDirectories.push(notDirectory.slice(0, -5));
  await Bun.write(notDirectory, "not a directory");
  const child = await run(
    ["--version", fixture.version],
    {
      ...process.env,
      SHELL: "/usr/bin/zsh",
      ZDOTDIR: notDirectory,
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    },
    undefined,
    { zdotdir: notDirectory },
  );
  expect(child.exitCode).not.toBe(0);
  expect(child.stderr).toContain("PATH could not be saved");
  expect(child.stderr).not.toContain(`CoForge Computer ${fixture.version} installed`);
});

test("install.sh shows curl progress only for the binary download on a terminal", async () => {
  const fixture = await serveFixture();
  const directory = await mkdtemp(join(tmpdir(), "coforge-curl-wrapper-"));
  temporaryDirectories.push(directory);
  const curlLog = join(directory, "curl.log");
  const realCurl = Bun.which("curl");
  if (!realCurl) throw new Error("curl is required for installer tests");
  await Bun.write(
    join(directory, "curl"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CURL_ARGUMENT_LOG"\nexec "${realCurl}" "$@"\n`,
  );
  await Bun.spawn({ cmd: ["chmod", "700", join(directory, "curl")] }).exited;
  const home = await mkdtemp(join(tmpdir(), "coforge-installer-home-"));
  temporaryDirectories.push(home);
  const child = Bun.spawn({
    cmd:
      process.platform === "darwin"
        ? ["script", "-q", "/dev/null", script, "--version", "latest"]
        : ["script", "-q", "-e", "-c", `${script} --version latest`, "/dev/null"],
    env: {
      ...process.env,
      HOME: home,
      SHELL: "/usr/bin/bash",
      PATH: `${directory}:${process.env.PATH}`,
      CURL_ARGUMENT_LOG: curlLog,
      COFORGE_RELEASE_FEED_URL: fixture.baseUrl,
      COFORGE_INSTALLER_TEST_MODE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  const calls = (await readFile(curlLog, "utf8")).trim().split("\n");
  const latest = calls.find((call) => call.endsWith("/latest"));
  const sidecar = calls.find((call) => call.includes("coforge-computer.sha256"));
  const binary = calls.find((call) => call.includes("coforge-computer.gz"));
  expect(latest).toContain("--silent");
  expect(sidecar).toContain("--silent");
  expect(latest).not.toContain("--progress-bar");
  expect(sidecar).not.toContain("--progress-bar");
  expect(binary).toContain("--progress-bar");
  expect(binary).not.toContain("--silent");
});

test("install scripts fail closed and stay within the current user's own account", async () => {
  const shell = await readFile(
    resolve(import.meta.dir, "../../../scripts/release/install.sh"),
    "utf8",
  );
  const powershell = await readFile(
    resolve(import.meta.dir, "../../../scripts/release/install.ps1"),
    "utf8",
  );

  expect(shell).not.toContain("sudo");
  expect(shell).not.toContain("/usr/local");
  expect(powershell).not.toContain("Program Files");
  expect(powershell).not.toContain("Start-Process -Verb RunAs");
  // Neither installer pins a checksum for any published object: every payload is verified
  // against the checksum its feed-hosted sidecar (install.sh, install.ps1) or manifest.json
  // (the updater) names at install time.
  expect(shell).not.toMatch(/[0-9a-f]{64}/);
  expect(powershell).not.toMatch(/[0-9a-f]{64}/);
  expect(shell).toContain("HTTPS");
  // curl's progress meter is noisy when stderr is captured by a terminal wrapper. The installer
  // already emits one line per meaningful step and must leave the user with an actionable PATH
  // fix for the user-local shim (a child shell cannot modify its parent's PATH).
  expect(shell).toContain("fetch_binary()");
  expect(shell).toContain("fetch_binary --max-filesize");
  expect(shell).toContain("export PATH=");
  expect(shell).toContain("$HOME/.coforge/computer/bin");
  expect(powershell).toContain("HTTPS");
  // Neither script's size-cap constants may ever be a literal 0: curl treats `--max-filesize 0`
  // as "unlimited" (N4), and install.ps1's Get-CoforgeObject enforces its MaxBytes with a plain
  // `-gt` comparison that a 0 would also defeat (anything read would immediately exceed it, but
  // a cap of 0 has no legitimate meaning here either way - pin both away from it explicitly).
  expect(shell).not.toMatch(/--max-filesize\s+["']?0(?!\d)/);
  expect(shell).toMatch(/^max_pointer_bytes=[1-9]\d*$/m);
  expect(shell).toMatch(/^max_binary_bytes=[1-9]\d*$/m);
  expect(powershell).toMatch(/^\$maxPointerBytes = [1-9]\d*$/m);
  expect(powershell).toMatch(/^\$maxBinaryBytes = [1-9]\d*$/m);
  // install.sh no longer parses JSON in the shell at all (B1): no jq invocation, and no request
  // for the manifest ("install.sh resolves latest and an explicit version, and never touches
  // manifest.json" above proves that behaviorally; this just confirms no code path can even
  // construct that request).
  expect(shell).not.toContain("jq ");
  expect(shell).not.toContain("/manifest.json");
  expect(shell).toContain("coforge-computer.gz");
  expect(powershell).toContain("coforge-computer.gz");
  expect(powershell).toContain("System.IO.Compression.GZipStream");
  expect(powershell).not.toContain('target/coforge-computer"');
});
