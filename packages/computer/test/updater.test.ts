import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ComputerUpdater, UpdateError } from "../src/updater";

const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function sha256(bytes: Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
}

function envelope(payload: unknown, privateKey: KeyObject): Buffer {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  const signature = sign(
    null,
    Buffer.from(`coforge-release-v1\nfixture-key\n${encoded}`),
    privateKey,
  );
  return Buffer.from(
    JSON.stringify({
      schema_version: 1,
      key_id: "fixture-key",
      payload: encoded,
      signature: signature.toString("base64"),
    }),
  );
}

async function fixture(
  options: {
    generation?: number;
    production?: "current" | null;
    test?: "current" | null;
    tamperSignature?: boolean;
    tamperPayload?: boolean;
    tamperBundleIdentity?: boolean;
    target?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "coforge-updater-"));
  temporaryDirectories.push(directory);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const target = options.target ?? (process.platform === "darwin" ? "darwin-x64" : "linux-x64");
  const computer = Buffer.from("computer-v2");
  const daemon = Buffer.from(options.tamperPayload ? "tampered-daemon" : "daemon-v2");
  const expectedDaemon = Buffer.from("daemon-v2");
  const computerManifest = envelope(
    {
      schema_version: 1,
      component: "computer",
      version: "2.0.0",
      artifacts: { [target]: { size: computer.length, sha256: sha256(computer) } },
    },
    privateKey,
  );
  const daemonManifest = envelope(
    {
      schema_version: 1,
      component: "daemon",
      version: "2.0.0",
      artifacts: { [target]: { size: expectedDaemon.length, sha256: sha256(expectedDaemon) } },
    },
    privateKey,
  );
  const computerManifestDigest = sha256(computerManifest);
  const daemonManifestDigest = sha256(daemonManifest);
  const bundlePayload = {
    schema_version: 1,
    computer: {
      component_manifest_sha256: computerManifestDigest,
      size: computer.length,
      sha256: sha256(computer),
      url: "artifacts/computer",
    },
    daemon: {
      component_manifest_sha256: daemonManifestDigest,
      size: options.tamperBundleIdentity ? expectedDaemon.length + 1 : expectedDaemon.length,
      sha256: sha256(expectedDaemon),
      url: "artifacts/daemon",
    },
  };
  const bundle = envelope(bundlePayload, privateKey);
  const releasePayload = {
    schema_version: 1,
    components: {
      computer: {
        url: "releases/computer/2.0.0/manifest.json",
        size: computerManifest.length,
        sha256: computerManifestDigest,
      },
      daemon: {
        url: "releases/daemon/2.0.0/manifest.json",
        size: daemonManifest.length,
        sha256: daemonManifestDigest,
      },
    },
    bundles: {
      [target]: { url: `bundles/${target}.json`, size: bundle.length, sha256: sha256(bundle) },
    },
  };
  const releasePayloadBytes = Buffer.from(JSON.stringify(releasePayload));
  const actualSelector = sha256(releasePayloadBytes);
  const releaseBytes = envelope(releasePayload, privateKey);

  const channelPayload = {
    schema_version: 1,
    generation: options.generation ?? 1,
    channels: {
      production: { current: options.production === null ? null : actualSelector, previous: null },
      test: { current: options.test === null ? null : actualSelector, previous: null },
    },
  };
  let channelBytes = envelope(channelPayload, privateKey);
  if (options.tamperSignature) {
    const parsed = JSON.parse(Buffer.from(channelBytes).toString("utf8"));
    parsed.signature = `${parsed.signature[0] === "A" ? "B" : "A"}${parsed.signature.slice(1)}`;
    channelBytes = Buffer.from(JSON.stringify(parsed));
  }

  const files = new Map<string, Uint8Array>([
    ["/channels.json", channelBytes],
    [`/release-sets/${actualSelector}/manifest.json`, releaseBytes],
    [`/release-sets/${actualSelector}/bundles/${target}.json`, bundle],
    [`/release-sets/${actualSelector}/artifacts/computer`, computer],
    [`/release-sets/${actualSelector}/artifacts/daemon`, daemon],
    ["/releases/computer/2.0.0/manifest.json", computerManifest],
    ["/releases/daemon/2.0.0/manifest.json", daemonManifest],
  ]);
  const requested: string[] = [];
  let server: ReturnType<typeof Bun.serve>;
  server = Bun.serve({
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
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    baseUrl: `http://localhost:${server.port}/`,
    target,
    selector: actualSelector,
    requested,
  };
}

function updater(input: Awaited<ReturnType<typeof fixture>>) {
  return new ComputerUpdater({
    baseUrl: input.baseUrl,
    trustedKeys: { "fixture-key": input.publicKey },
    target: input.target,
    installRoot: input.directory,
  });
}

test("latest, test, and exact selectors install only their resolved release set", async () => {
  for (const selection of ["latest", "test", "exact"] as const) {
    const input = await fixture();
    const selected = selection === "exact" ? input.selector : selection;

    const result = await updater(input).install(selected);

    expect(result.releaseSet).toBe(input.selector);
    expect(
      await readFile(
        join(input.directory, "versions", input.selector.slice(7), "coforge-computer"),
        "utf8",
      ),
    ).toBe("computer-v2");
    expect(
      await readFile(
        join(input.directory, "versions", input.selector.slice(7), "coforge-daemon"),
        "utf8",
      ),
    ).toBe("daemon-v2");
  }
});

test("an unpublished channel fails closed without trying another selector", async () => {
  const input = await fixture({ production: null });

  await expect(updater(input).install("latest")).rejects.toMatchObject({
    code: "UPDATE_NOT_PUBLISHED",
  });
  await expect(readFile(join(input.directory, "active.json"))).rejects.toThrow();
});

test("invalid signatures and decreasing generations are rejected", async () => {
  const invalid = await fixture({ tamperSignature: true });
  await expect(updater(invalid).install("latest")).rejects.toBeInstanceOf(UpdateError);

  const stale = await fixture({ generation: 4 });
  await writeFile(
    join(stale.directory, "update-state.json"),
    JSON.stringify({ schema_version: 1, generation: 5 }),
  );
  await expect(updater(stale).install("latest")).rejects.toMatchObject({
    code: "UPDATE_GENERATION_ROLLBACK",
  });
});

test("a served payload that does not match its signed digest is rejected", async () => {
  const input = await fixture({ tamperPayload: true });

  // The signed bundle and component manifest agree; only the bytes the feed serves differ,
  // which is what a compromised bucket looks like. Pin the message so the test cannot start
  // passing for some earlier reason.
  await expect(updater(input).install("latest")).rejects.toMatchObject({
    code: "UPDATE_INTEGRITY_FAILED",
    message: expect.stringContaining("downloaded artifact failed integrity"),
  });
  await expect(readFile(join(input.directory, "active.json"))).rejects.toThrow();
});

test("a bundle that disagrees with its component manifest is rejected before downloading", async () => {
  const input = await fixture({ tamperBundleIdentity: true });

  await expect(updater(input).install("latest")).rejects.toMatchObject({
    code: "UPDATE_INTEGRITY_FAILED",
    message: expect.stringContaining("does not match both recorded identities"),
  });
  expect(input.requested).toContain(`/release-sets/${input.selector}/bundles/${input.target}.json`);
  expect(input.requested).not.toContain(`/release-sets/${input.selector}/artifacts/daemon`);
  expect(input.requested).not.toContain(`/release-sets/${input.selector}/artifacts/computer`);
});

test("activation preserves a complete previous bundle and rollback works offline", async () => {
  const first = await fixture();
  const manager = updater(first);
  await manager.install("latest");
  const priorDirectory = join(first.directory, "versions", first.selector.slice(7));
  await chmod(join(priorDirectory, "coforge-computer"), 0o755);

  const second = await fixture();
  const secondManager = new ComputerUpdater({
    baseUrl: second.baseUrl,
    trustedKeys: { "fixture-key": second.publicKey },
    target: second.target,
    installRoot: first.directory,
  });
  await secondManager.install(second.selector);

  servers.splice(0).forEach((server) => server.stop(true));
  const rolledBack = await secondManager.rollback();
  expect(rolledBack.releaseSet).toBe(first.selector);
  expect(JSON.parse(await readFile(join(first.directory, "active.json"), "utf8"))).toMatchObject({
    current: first.selector,
    previous: second.selector,
  });
});

test("rollback refuses a locally corrupted previous payload", async () => {
  const first = await fixture();
  const manager = updater(first);
  await manager.install("latest");
  const second = await fixture();
  const secondManager = new ComputerUpdater({
    baseUrl: second.baseUrl,
    trustedKeys: { "fixture-key": second.publicKey },
    target: second.target,
    installRoot: first.directory,
  });
  await secondManager.install(second.selector);
  await writeFile(
    join(first.directory, "versions", first.selector.slice(7), "coforge-daemon"),
    "corrupted",
  );

  await expect(secondManager.rollback()).rejects.toMatchObject({ code: "UPDATE_INTEGRITY_FAILED" });
});

test("the supported platform matrix selects one complete target bundle", async () => {
  for (const target of [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "windows-x64",
    "windows-arm64",
  ]) {
    const input = await fixture({ target });
    await updater(input).install(input.selector);
    const version = join(input.directory, "versions", input.selector.slice(7));
    const suffix = target.startsWith("windows-") ? ".exe" : "";
    expect(await readFile(join(version, `coforge-computer${suffix}`), "utf8")).toBe("computer-v2");
    expect(await readFile(join(version, `coforge-daemon${suffix}`), "utf8")).toBe("daemon-v2");
    const shim = target.startsWith("windows-")
      ? join(input.directory, "bin", "coforge-computer.cmd")
      : join(input.directory, "bin", "coforge-computer");
    const shimStat = await stat(shim);
    expect(shimStat.isFile() || shimStat.isSymbolicLink()).toBe(true);
  }
});
