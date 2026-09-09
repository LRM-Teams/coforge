import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ComputerUpdater } from "../src/updater";
import { runCli } from "../src/cli";

const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function sha256hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function flipByte(buffer: Buffer): Buffer {
  const copy = Buffer.from(buffer);
  copy[0] = (copy[0] ?? 0) ^ 0xff;
  return copy;
}

async function fixture(
  options: {
    version?: string;
    target?: string;
    tamperComputer?: boolean;
    oversizeComputer?: boolean;
    malformedManifest?: boolean;
    omitLatest?: boolean;
    omitPlatform?: boolean;
    manifestVersion?: string;
    wrongComputerBinary?: boolean;
    schemaVersion?: number;
    includeDaemon?: boolean;
    redirectLatest?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "coforge-updater-"));
  temporaryDirectories.push(directory);
  const target = options.target ?? (process.platform === "darwin" ? "darwin-x64" : "linux-x64");
  const version = options.version ?? "2.0.0";
  const computer = Buffer.from("computer-payload-v2");
  const compressedComputer = Bun.gzipSync(computer);
  const computerGzip = {
    binary: "coforge-computer.gz",
    size: compressedComputer.length,
    checksum: sha256hex(compressedComputer),
  };
  const manifest = {
    schema_version: options.schemaVersion ?? 2,
    version: options.manifestVersion ?? version,
    commit: "a".repeat(40),
    buildDate: "2026-09-04T12:00:00Z",
    platforms: options.omitPlatform
      ? {}
      : {
          [target]: {
            computer: {
              binary: options.wrongComputerBinary ? "other-computer" : "coforge-computer",
              checksum: sha256hex(computer),
              size: computer.length,
              gzip: computerGzip,
            },
            ...(options.includeDaemon ? { daemon: { binary: "coforge-daemon" } } : {}),
          },
        },
  };
  const manifestBytes = Buffer.from(
    JSON.stringify(options.malformedManifest ? { schema_version: 2, oops: true } : manifest),
  );
  const servedComputer = options.oversizeComputer
    ? Buffer.concat([computer, Buffer.alloc(computer.length * 4, 0x41)])
    : options.tamperComputer
      ? flipByte(computer)
      : computer;

  const files = new Map<string, Uint8Array>([
    [`/${version}/manifest.json`, manifestBytes],
    [`/${version}/${target}/coforge-computer.gz`, Bun.gzipSync(new Uint8Array(servedComputer))],
  ]);
  // redirectLatest points "/latest" at a 302 whose destination serves the very same, otherwise
  // completely valid, version content - so a full install would succeed if the redirect refusal
  // were the only thing missing, rather than tripping over some unrelated 404 downstream. See
  // the B3-2 redirect test below.
  if (options.redirectLatest) {
    files.set("/latest-real", Buffer.from(`${version}\n`));
  } else if (!options.omitLatest) {
    files.set("/latest", Buffer.from(`${version}\n`));
  }

  const requested: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requested.push(path);
      if (options.redirectLatest && path === "/latest") {
        return new Response(null, { status: 302, headers: { Location: "/latest-real" } });
      }
      const bytes = files.get(path);
      return bytes ? new Response(Buffer.from(bytes)) : new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return {
    directory,
    baseUrl: `http://localhost:${server.port}/`,
    target,
    version,
    requested,
    files,
  };
}

function updater(input: Awaited<ReturnType<typeof fixture>>) {
  return new ComputerUpdater({
    baseUrl: input.baseUrl,
    target: input.target,
    installRoot: input.directory,
  });
}

test("gzip corruption, missing objects, invalid paths and oversized expansion never activate", async () => {
  for (const failure of [
    "checksum",
    "raw-checksum",
    "missing",
    "path",
    "expansion",
    "invalid-gzip",
  ] as const) {
    const input = await fixture();
    const manifestPath = `/${input.version}/manifest.json`;
    const manifest = JSON.parse(new TextDecoder().decode(input.files.get(manifestPath)));
    const artifact = manifest.platforms[input.target].computer;
    const raw = Bun.gunzipSync(
      Buffer.from(input.files.get(`/${input.version}/${input.target}/coforge-computer.gz`)!),
    );
    const compressed =
      failure === "invalid-gzip"
        ? raw
        : Bun.gzipSync(failure === "expansion" ? new Uint8Array(1024) : Buffer.from(raw));
    artifact.gzip = {
      binary: failure === "path" ? "../coforge-computer.gz" : "coforge-computer.gz",
      size: compressed.length,
      checksum: failure === "checksum" ? "0".repeat(64) : sha256hex(compressed),
    };
    if (failure === "raw-checksum") artifact.checksum = "0".repeat(64);
    input.files.set(manifestPath, Buffer.from(JSON.stringify(manifest)));
    if (failure === "missing")
      input.files.delete(`/${input.version}/${input.target}/coforge-computer.gz`);
    else input.files.set(`/${input.version}/${input.target}/coforge-computer.gz`, compressed);
    await expect(updater(input).install(input.version)).rejects.toThrow();
    expect(await Bun.file(join(input.directory, "active.json")).exists()).toBe(false);
    expect(input.requested).not.toContain(`/${input.version}/${input.target}/coforge-computer`);
  }
});

test("a manifest without gzip metadata is rejected rather than downloading raw binaries", async () => {
  const input = await fixture();
  const path = `/${input.version}/manifest.json`;
  const manifest = JSON.parse(new TextDecoder().decode(input.files.get(path)));
  delete manifest.platforms[input.target].computer.gzip;
  input.files.set(path, Buffer.from(JSON.stringify(manifest)));
  await expect(updater(input).install(input.version)).rejects.toMatchObject({
    code: "UPDATE_FEED_INVALID",
  });
  expect(input.requested).toEqual([path]);
});

test("offline rollback rejects a missing or corrupted version-local Agent launcher", async () => {
  for (const missing of [true, false]) {
    const input = await fixture();
    const client = updater(input);
    await client.install(input.version);
    await writeFile(
      join(input.directory, "active.json"),
      JSON.stringify({ schema_version: 1, current: "3.0.0", previous: input.version }),
    );
    const launcher = join(input.directory, "versions", input.version, "coforge");
    if (missing) await rm(launcher);
    else await writeFile(launcher, "wrong launcher");
    await expect(client.rollback()).rejects.toThrow();
    expect(JSON.parse(await readFile(join(input.directory, "active.json"), "utf8")).current).toBe(
      "3.0.0",
    );
  }
});

test.each(["latest", "0.1.0-dev.15"])(
  "upgrade skips consent and activation for the active version: %s",
  async (selection) => {
    const input = await fixture({ version: "0.1.0-dev.15" });
    const manager = updater(input);
    await manager.install("latest");
    input.requested.length = 0;
    const output: string[] = [];
    let prompted = false;
    let upgraded = false;
    const code = await runCli(
      ["upgrade", "--version", selection],
      {
        login: { async run() {} },
        setup: { async run() {} },
        updater: {
          resolveVersion: (selector) => manager.resolveVersion(selector),
          getCurrentVersion: () => manager.getCurrentVersion(),
          async install() {},
          async rollback() {},
          async upgrade() {
            upgraded = true;
          },
        },
      },
      {
        stdout: (line) => output.push(line),
        stderr: (line) => output.push(line),
        prompt: () => {
          prompted = true;
          return "y";
        },
      },
    );
    expect(code).toBe(0);
    expect(prompted).toBe(false);
    expect(upgraded).toBe(false);
    expect(output).toEqual(["Already up to date: 0.1.0-dev.15"]);
    expect(input.requested).toEqual(selection === "latest" ? ["/latest"] : []);
  },
);

test("current version is absent before installation and follows the active installation", async () => {
  const input = await fixture({ version: "0.1.0-dev.15" });
  const manager = updater(input);
  expect(await manager.getCurrentVersion()).toBeNull();
  await manager.install("latest");
  expect(await manager.getCurrentVersion()).toBe("0.1.0-dev.15");
});

test("a self-referencing latest pointer fails before upgrade consent", async () => {
  const input = await fixture({ version: "latest" });
  const manager = updater(input);
  let prompted = false;
  let upgraded = false;
  const errors: string[] = [];
  const code = await runCli(
    ["upgrade"],
    {
      login: { async run() {} },
      setup: { async run() {} },
      updater: {
        resolveVersion: (selector) => manager.resolveVersion(selector),
        getCurrentVersion: () => manager.getCurrentVersion(),
        async install() {},
        async rollback() {},
        async upgrade() {
          upgraded = true;
        },
      },
    },
    {
      stdout: () => {},
      stderr: (line) => errors.push(line),
      prompt: () => {
        prompted = true;
        return "y";
      },
    },
  );
  expect(code).toBe(1);
  expect(errors.join("\n")).toContain("UPDATE_FEED_INVALID");
  expect(prompted).toBe(false);
  expect(upgraded).toBe(false);
  expect(input.requested).toEqual(["/latest"]);
});

test("resolving latest is read-only and preparation keeps the confirmed version after pointer changes", async () => {
  const input = await fixture({ version: "2.0.0" });
  const manager = updater(input);
  const version = await manager.resolveVersion("latest");
  expect(version).toBe("2.0.0");
  expect(input.requested).toEqual(["/latest"]);
  expect(await readdir(input.directory)).toEqual([]);

  input.files.set("/latest", Buffer.from("3.0.0\n"));
  const prepared = await manager.prepare(version);
  expect(prepared.version).toBe("2.0.0");
  expect(input.requested).toEqual([
    "/latest",
    "/2.0.0/manifest.json",
    `/2.0.0/${input.target}/coforge-computer.gz`,
  ]);
  expect(await Bun.file(join(input.directory, "active.json")).exists()).toBe(false);
});

test("latest and an exact version selector resolve to the same install", async () => {
  for (const selection of ["latest", "exact"] as const) {
    const input = await fixture();
    const selected = selection === "exact" ? input.version : selection;

    const result = await updater(input).install(selected);

    expect(result.version).toBe(input.version);
    expect(
      await readFile(join(input.directory, "versions", input.version, "coforge-computer"), "utf8"),
    ).toBe("computer-payload-v2");
    expect(
      await Bun.file(join(input.directory, "versions", input.version, "coforge-daemon")).exists(),
    ).toBe(false);
    expect(
      JSON.parse(
        await readFile(
          join(input.directory, "versions", input.version, "installation.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      schema_version: 2,
      version: input.version,
      computer: {
        size: Buffer.byteLength("computer-payload-v2"),
        checksum: sha256hex(Buffer.from("computer-payload-v2")),
      },
      agentCli: expect.any(Object),
    });
  }
});

test("an unreachable latest pointer and an unparsable version selector fail closed", async () => {
  const missing = await fixture({ omitLatest: true });
  await expect(updater(missing).install("latest")).rejects.toMatchObject({
    code: "UPDATE_FEED_INVALID",
  });

  const input = await fixture();
  await expect(updater(input).install("../etc/passwd")).rejects.toMatchObject({
    code: "UPDATE_FEED_INVALID",
  });
  // The selector is rejected before any network access, so nothing was requested.
  expect(input.requested).toEqual([]);
});

test("a latest pointer that is not a version string is rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-updater-"));
  temporaryDirectories.push(directory);
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      return path === "/latest"
        ? new Response("<html>not found</html>")
        : new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const manager = new ComputerUpdater({
    baseUrl: `http://localhost:${server.port}/`,
    target: "linux-x64",
    installRoot: directory,
  });

  await expect(manager.install("latest")).rejects.toMatchObject({ code: "UPDATE_FEED_INVALID" });
});

test("a redirected feed response is rejected even when the redirect target is otherwise a complete, valid install", async () => {
  // Everything the redirect leads to - the resolved version, its manifest, and both binaries -
  // is completely valid. Only `response.redirected` distinguishes this from a legitimate
  // install, so this is the one thing standing between passing and failing: a redirect to
  // something that also fails on its own merits (a 404, a malformed manifest) would not prove
  // the redirect check itself is doing the rejecting.
  const input = await fixture({ redirectLatest: true });

  await expect(updater(input).install("latest")).rejects.toMatchObject({
    code: "UPDATE_FEED_INVALID",
  });
});

test("a manifest whose version field does not match the requested version is rejected", async () => {
  const input = await fixture({ manifestVersion: "9.9.9" });

  await expect(updater(input).install("latest")).rejects.toMatchObject({
    code: "UPDATE_FEED_INVALID",
    message: expect.stringContaining("does not match requested version"),
  });
});

test("a manifest that does not pin the computer artifact name is rejected", async () => {
  const input = await fixture({ wrongComputerBinary: true });

  await expect(updater(input).install("latest")).rejects.toMatchObject({
    code: "UPDATE_FEED_INVALID",
  });
  expect(input.requested).not.toContain(`/${input.version}/${input.target}/coforge-computer`);
});

test("schema 1 and a daemon member are rejected without legacy compatibility", async () => {
  for (const options of [{ schemaVersion: 1 }, { includeDaemon: true }]) {
    const input = await fixture(options);
    await expect(updater(input).install("latest")).rejects.toMatchObject({
      code: "UPDATE_FEED_INVALID",
    });
  }
});

test("a version of '.' or one that starts with '-' is rejected", async () => {
  const input = await fixture();
  for (const invalid of [".", "-rf"]) {
    await expect(updater(input).install(invalid)).rejects.toMatchObject({
      code: "UPDATE_FEED_INVALID",
    });
  }
  // Rejected before any network access. Without this, a "." or "-rf" selector that slipped past
  // validation would still 404 against the feed and fail with the same UPDATE_FEED_INVALID code,
  // which would let this test pass for the wrong reason.
  expect(input.requested).toEqual([]);
});

test("rollback refuses a previous version of '.' or one that starts with '-'", async () => {
  const input = await fixture();
  await updater(input).install("latest");
  for (const invalid of [".", "-rf"]) {
    await writeFile(
      join(input.directory, "active.json"),
      `${JSON.stringify({ schema_version: 1, current: input.version, previous: invalid })}\n`,
    );
    await expect(updater(input).rollback()).rejects.toMatchObject({ code: "UPDATE_NO_ROLLBACK" });
  }
});

test("a manifest with an invalid schema is rejected", async () => {
  const input = await fixture({ malformedManifest: true });

  await expect(updater(input).install("latest")).rejects.toMatchObject({
    code: "UPDATE_FEED_INVALID",
  });
});

test("a null platform entry is rejected as an invalid feed", async () => {
  const input = await fixture();
  const key = `/${input.version}/manifest.json`;
  const manifest = JSON.parse(new TextDecoder().decode(input.files.get(key)));
  manifest.platforms[input.target] = null;
  input.files.set(key, Buffer.from(JSON.stringify(manifest)));
  await expect(updater(input).install("latest")).rejects.toMatchObject({
    code: "UPDATE_FEED_INVALID",
  });
});

test("a manifest missing the current platform is rejected", async () => {
  const input = await fixture({ omitPlatform: true });

  await expect(updater(input).install("latest")).rejects.toMatchObject({
    code: "UPDATE_UNSUPPORTED_TARGET",
  });
});

test("a served payload that does not match its manifest checksum is rejected", async () => {
  const input = await fixture({ tamperComputer: true });

  // The manifest and the served bytes disagree only in content, not length, which is what a
  // compromised feed object looks like. Pin the message so this cannot start passing for some
  // earlier reason.
  await expect(updater(input).install("latest")).rejects.toMatchObject({
    code: "UPDATE_INTEGRITY_FAILED",
    message: expect.stringContaining("failed integrity"),
  });
  await expect(readFile(join(input.directory, "active.json"))).rejects.toThrow();
});

test("a payload larger than its recorded size is rejected before it is buffered", async () => {
  const input = await fixture({ oversizeComputer: true });

  await expect(updater(input).install("latest")).rejects.toMatchObject({
    code: "UPDATE_INTEGRITY_FAILED",
    message: expect.stringContaining("larger than its recorded size"),
  });
});

test("activation preserves a complete previous version and rollback works offline", async () => {
  const first = await fixture({ version: "2.0.0" });
  const manager = updater(first);
  await manager.install("latest");
  const priorDirectory = join(first.directory, "versions", first.version);
  await chmod(join(priorDirectory, "coforge-computer"), 0o755);

  const second = await fixture({ version: "2.1.0", target: first.target });
  const secondManager = new ComputerUpdater({
    baseUrl: second.baseUrl,
    target: second.target,
    installRoot: first.directory,
  });
  await secondManager.install(second.version);

  servers.splice(0).forEach((server) => server.stop(true));
  const rolledBack = await secondManager.rollback();
  expect(rolledBack.version).toBe(first.version);
  expect(JSON.parse(await readFile(join(first.directory, "active.json"), "utf8"))).toMatchObject({
    current: first.version,
    previous: second.version,
  });
});

test("prepare verifies old bytes and downloads the candidate without activating it", async () => {
  const first = await fixture({ version: "2.0.0" });
  await updater(first).install("latest");
  const second = await fixture({ version: "2.1.0", target: first.target });
  const manager = new ComputerUpdater({
    baseUrl: second.baseUrl,
    target: second.target,
    installRoot: first.directory,
  });

  expect(await manager.prepare(second.version)).toEqual({
    version: second.version,
    previous: first.version,
    rollbackVersion: null,
  });
  expect(JSON.parse(await readFile(join(first.directory, "active.json"), "utf8")).current).toBe(
    first.version,
  );
  expect(
    await Bun.file(join(first.directory, "versions", second.version, "coforge-computer")).exists(),
  ).toBe(true);
});

test("prepare refuses to quiesce when the active rollback bytes are corrupted", async () => {
  const first = await fixture({ version: "2.0.0" });
  await updater(first).install("latest");
  await writeFile(join(first.directory, "versions", first.version, "coforge-computer"), "bad");
  const second = await fixture({ version: "2.1.0", target: first.target });
  const manager = new ComputerUpdater({
    baseUrl: second.baseUrl,
    target: second.target,
    installRoot: first.directory,
  });

  await expect(manager.prepare(second.version)).rejects.toMatchObject({
    code: "UPDATE_INTEGRITY_FAILED",
  });
});

test("failed candidate restoration preserves the prior healthy rollback selection", async () => {
  const first = await fixture({ version: "1.0.0" });
  await updater(first).install(first.version);
  const second = await fixture({ version: "2.0.0", target: first.target });
  await new ComputerUpdater({
    baseUrl: second.baseUrl,
    target: first.target,
    installRoot: first.directory,
  }).install(second.version);
  const candidate = await fixture({ version: "3.0.0", target: first.target });
  const manager = new ComputerUpdater({
    baseUrl: candidate.baseUrl,
    target: first.target,
    installRoot: first.directory,
  });
  const prepared = await manager.prepare(candidate.version);
  await manager.activatePrepared(prepared);
  await manager.restoreVerified(prepared.previous!, prepared.rollbackVersion ?? null);
  expect((await manager.rollback()).version).toBe(first.version);
});

test("rollback refuses a locally corrupted previous payload", async () => {
  const first = await fixture({ version: "2.0.0" });
  const manager = updater(first);
  await manager.install("latest");
  const second = await fixture({ version: "2.1.0", target: first.target });
  const secondManager = new ComputerUpdater({
    baseUrl: second.baseUrl,
    target: second.target,
    installRoot: first.directory,
  });
  await secondManager.install(second.version);
  await writeFile(
    join(first.directory, "versions", first.version, "coforge-computer"),
    "corrupted",
  );

  await expect(secondManager.rollback()).rejects.toMatchObject({ code: "UPDATE_INTEGRITY_FAILED" });
});

test("rollback without a previous version fails closed", async () => {
  const input = await fixture();
  await updater(input).install("latest");

  await expect(updater(input).rollback()).rejects.toMatchObject({ code: "UPDATE_NO_ROLLBACK" });
});

test("concurrent callers on one updater instance cannot inherit lock ownership", async () => {
  const input = await fixture();
  const manager = updater(input);
  await manager.withExclusiveOperation(async () => {
    await expect(manager.install(input.version)).rejects.toMatchObject({ code: "UPDATE_BUSY" });
  });
});

test("SIGKILL releases the permanent machine mutation lock without replacing it", async () => {
  const input = await fixture();
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("fixtures/update-lock-child.ts", import.meta.url).pathname,
      input.directory,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  const output = child.stdout instanceof ReadableStream ? child.stdout.getReader() : null;
  expect(output).not.toBeNull();
  expect(new TextDecoder().decode((await output!.read()).value).trim()).toBe("acquired");
  const lockPath = join(input.directory, "machine-mutation-lock.sqlite");
  const inode = (await stat(lockPath)).ino;
  child.kill("SIGKILL");
  await child.exited;

  await expect(
    updater(input).withExclusiveOperation(async () => undefined),
  ).resolves.toBeUndefined();
  expect((await stat(lockPath)).ino).toBe(inode);
});

test("the supported platform matrix selects one complete target set", async () => {
  for (const target of [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "windows-x64",
    "windows-arm64",
  ]) {
    const input = await fixture({ target });
    await updater(input).install(input.version);
    const version = join(input.directory, "versions", input.version);
    const suffix = target.startsWith("windows-") ? ".exe" : "";
    expect(await readFile(join(version, `coforge-computer${suffix}`), "utf8")).toBe(
      "computer-payload-v2",
    );
    expect(await Bun.file(join(version, `coforge-daemon${suffix}`)).exists()).toBe(false);
    const agentCli = await readFile(
      join(version, target.startsWith("windows-") ? "coforge.cmd" : "coforge"),
      "utf8",
    );
    expect(agentCli).toContain(`coforge-computer${suffix}`);
    expect(agentCli).toContain("__agent-cli");
    const shim = target.startsWith("windows-")
      ? join(input.directory, "bin", "coforge-computer.cmd")
      : join(input.directory, "bin", "coforge-computer");
    const shimStat = await stat(shim);
    expect(shimStat.isFile() || shimStat.isSymbolicLink()).toBe(true);
  }
});
