import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ComputerUpdater } from "../src/updater";

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
    tamperDaemon?: boolean;
    oversizeDaemon?: boolean;
    malformedManifest?: boolean;
    omitLatest?: boolean;
    omitPlatform?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "coforge-updater-"));
  temporaryDirectories.push(directory);
  const target = options.target ?? (process.platform === "darwin" ? "darwin-x64" : "linux-x64");
  const version = options.version ?? "2.0.0";
  const computer = Buffer.from("computer-payload-v2");
  const daemon = Buffer.from("daemon-payload-v2");

  const manifest = {
    schema_version: 1,
    version,
    commit: "a".repeat(40),
    buildDate: "2026-09-04T12:00:00Z",
    platforms: options.omitPlatform
      ? {}
      : {
          [target]: {
            computer: {
              binary: "coforge-computer",
              checksum: sha256hex(computer),
              size: computer.length,
            },
            daemon: {
              binary: "coforge-daemon",
              checksum: sha256hex(daemon),
              size: daemon.length,
            },
          },
        },
  };
  const manifestBytes = Buffer.from(
    JSON.stringify(options.malformedManifest ? { schema_version: 1, oops: true } : manifest),
  );
  const servedComputer = options.tamperComputer ? flipByte(computer) : computer;
  const servedDaemon = options.oversizeDaemon
    ? Buffer.concat([daemon, Buffer.alloc(daemon.length * 4, 0x41)])
    : options.tamperDaemon
      ? flipByte(daemon)
      : daemon;

  const files = new Map<string, Uint8Array>([
    [`/${version}/manifest.json`, manifestBytes],
    [`/${version}/${target}/coforge-computer`, servedComputer],
    [`/${version}/${target}/coforge-daemon`, servedDaemon],
  ]);
  if (!options.omitLatest) files.set("/latest", Buffer.from(`${version}\n`));

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
  return {
    directory,
    baseUrl: `http://localhost:${server.port}/`,
    target,
    version,
    requested,
  };
}

function updater(input: Awaited<ReturnType<typeof fixture>>) {
  return new ComputerUpdater({
    baseUrl: input.baseUrl,
    target: input.target,
    installRoot: input.directory,
  });
}

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
      await readFile(join(input.directory, "versions", input.version, "coforge-daemon"), "utf8"),
    ).toBe("daemon-payload-v2");
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

test("a manifest with an invalid schema is rejected", async () => {
  const input = await fixture({ malformedManifest: true });

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
  const input = await fixture({ tamperDaemon: true });

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
  const input = await fixture({ oversizeDaemon: true });

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
  await writeFile(join(first.directory, "versions", first.version, "coforge-daemon"), "corrupted");

  await expect(secondManager.rollback()).rejects.toMatchObject({ code: "UPDATE_INTEGRITY_FAILED" });
});

test("rollback without a previous version fails closed", async () => {
  const input = await fixture();
  await updater(input).install("latest");

  await expect(updater(input).rollback()).rejects.toMatchObject({ code: "UPDATE_NO_ROLLBACK" });
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
    expect(await readFile(join(version, `coforge-daemon${suffix}`), "utf8")).toBe(
      "daemon-payload-v2",
    );
    const shim = target.startsWith("windows-")
      ? join(input.directory, "bin", "coforge-computer.cmd")
      : join(input.directory, "bin", "coforge-computer");
    const shimStat = await stat(shim);
    expect(shimStat.isFile() || shimStat.isSymbolicLink()).toBe(true);
  }
});
