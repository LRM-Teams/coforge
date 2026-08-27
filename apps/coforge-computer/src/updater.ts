import { createPublicKey, verify } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const RELEASE_SET_PATTERN = /^sha256:[0-9a-f]{64}$/;

type SignedEnvelope = {
  schema_version: 1;
  key_id: string;
  payload: string;
  signature: string;
};

type ArtifactIdentity = { size: number; sha256: string };
type ComponentReference = ArtifactIdentity & { url: string };

type ChannelSnapshot = {
  schema_version: 1;
  generation: number;
  channels: Record<"production" | "test", { current: string | null; previous: string | null }>;
};

type ReleaseSet = {
  schema_version: 1;
  components: Record<"computer" | "daemon", ComponentReference>;
  bundles: Record<string, ComponentReference>;
};

type ComponentManifest = {
  schema_version: 1;
  component: "computer" | "daemon";
  version: string;
  artifacts: Record<string, ArtifactIdentity>;
};

type BundleMember = ArtifactIdentity & {
  component_manifest_sha256: string;
  payload: string;
};

type InstallationBundle = {
  schema_version: 1;
  computer: BundleMember;
  daemon: BundleMember;
};

type ActiveState = {
  schema_version: 1;
  current: string;
  previous: string | null;
};

type InstalledIdentity = {
  schema_version: 1;
  release_set: string;
  computer: ArtifactIdentity;
  daemon: ArtifactIdentity;
};

export class UpdateError extends Error {
  constructor(
    readonly code:
      | "UPDATE_BUSY"
      | "UPDATE_FEED_INVALID"
      | "UPDATE_GENERATION_ROLLBACK"
      | "UPDATE_INTEGRITY_FAILED"
      | "UPDATE_NOT_PUBLISHED"
      | "UPDATE_NO_ROLLBACK"
      | "UPDATE_UNSUPPORTED_TARGET",
    message: string,
  ) {
    super(message);
    this.name = "UpdateError";
  }
}

export interface ComputerUpdaterOptions {
  baseUrl: string;
  trustedKeys: Readonly<Record<string, string>>;
  target: string;
  installRoot: string;
  binaryDirectory?: string;
  fetch?: typeof globalThis.fetch;
}

export class ComputerUpdater {
  readonly #baseUrl: URL;
  readonly #trustedKeys: Readonly<Record<string, string>>;
  readonly #target: string;
  readonly #installRoot: string;
  readonly #binaryDirectory: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ComputerUpdaterOptions) {
    this.#baseUrl = new URL(
      options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
    );
    this.#trustedKeys = options.trustedKeys;
    this.#target = options.target;
    this.#installRoot = options.installRoot;
    this.#binaryDirectory = options.binaryDirectory ?? join(options.installRoot, "bin");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async install(selection: string): Promise<{ releaseSet: string; previous: string | null }> {
    return this.#withLock(async () => {
      const resolved = await this.#resolveSelection(selection);
      const releaseBytes = await this.#download(
        `release-sets/${resolved.releaseSet}/manifest.json`,
      );
      const verifiedRelease = this.#verifyEnvelope<ReleaseSet>(releaseBytes);
      if (sha256(verifiedRelease.payloadBytes) !== resolved.releaseSet) {
        throw integrity("release-set payload does not match its immutable selector");
      }
      this.#assertReleaseSet(verifiedRelease.value);

      const computerReference = verifiedRelease.value.components.computer;
      const daemonReference = verifiedRelease.value.components.daemon;
      const [computerBytes, daemonBytes] = await Promise.all([
        this.#downloadImmutable(computerReference, "releases/computer/"),
        this.#downloadImmutable(daemonReference, "releases/daemon/"),
      ]);
      const computerManifest = this.#verifyEnvelope<ComponentManifest>(computerBytes).value;
      const daemonManifest = this.#verifyEnvelope<ComponentManifest>(daemonBytes).value;
      this.#assertComponentManifest(computerManifest, "computer");
      this.#assertComponentManifest(daemonManifest, "daemon");

      const bundleReference = verifiedRelease.value.bundles[this.#target];
      if (!bundleReference) {
        throw new UpdateError(
          "UPDATE_UNSUPPORTED_TARGET",
          `release set has no bundle for ${this.#target}`,
        );
      }
      const bundleBytes = await this.#downloadImmutable(
        {
          ...bundleReference,
          url: `release-sets/${resolved.releaseSet}/${bundleReference.url}`,
        },
        `release-sets/${resolved.releaseSet}/bundles/`,
      );
      const bundle = this.#verifyEnvelope<InstallationBundle>(bundleBytes).value;
      const payloads = this.#verifyBundle(bundle, {
        computer: { digest: computerReference.sha256, manifest: computerManifest },
        daemon: { digest: daemonReference.sha256, manifest: daemonManifest },
      });

      const previousState = await this.#readJson<ActiveState>("active.json");
      await this.#installVersion(resolved.releaseSet, payloads);
      const previous =
        previousState?.current === resolved.releaseSet
          ? previousState.previous
          : (previousState?.current ?? null);
      const active = {
        schema_version: 1,
        current: resolved.releaseSet,
        previous,
      } satisfies ActiveState;
      await this.#activate(active);
      if (resolved.generation !== null) {
        await this.#writeJsonAtomic("update-state.json", {
          schema_version: 1,
          generation: resolved.generation,
        });
      }
      return { releaseSet: resolved.releaseSet, previous };
    });
  }

  async rollback(): Promise<{ releaseSet: string; previous: string }> {
    return this.#withLock(async () => {
      const active = await this.#readJson<ActiveState>("active.json");
      if (!active?.previous || !RELEASE_SET_PATTERN.test(active.previous)) {
        throw new UpdateError("UPDATE_NO_ROLLBACK", "no previous verified bundle is available");
      }
      await this.#assertInstalled(active.previous);
      const next: ActiveState = {
        schema_version: 1,
        current: active.previous,
        previous: active.current,
      };
      await this.#activate(next);
      return { releaseSet: next.current, previous: next.previous! };
    });
  }

  async #resolveSelection(
    selection: string,
  ): Promise<{ releaseSet: string; generation: number | null }> {
    if (RELEASE_SET_PATTERN.test(selection)) return { releaseSet: selection, generation: null };
    if (selection !== "latest" && selection !== "test") {
      throw new UpdateError(
        "UPDATE_FEED_INVALID",
        "version must be latest, test, or an exact sha256 release-set id",
      );
    }
    const channel = selection === "latest" ? "production" : "test";
    const bytes = await this.#download("channels.json");
    const snapshot = this.#verifyEnvelope<ChannelSnapshot>(bytes).value;
    this.#assertChannels(snapshot);
    const state = await this.#readJson<{ generation?: number }>("update-state.json");
    if (typeof state?.generation === "number" && snapshot.generation < state.generation) {
      throw new UpdateError(
        "UPDATE_GENERATION_ROLLBACK",
        `channel generation ${snapshot.generation} is older than accepted generation ${state.generation}`,
      );
    }
    const current = snapshot.channels[channel].current;
    if (current === null) {
      throw new UpdateError("UPDATE_NOT_PUBLISHED", `${channel} is not published`);
    }
    if (!RELEASE_SET_PATTERN.test(current)) {
      throw new UpdateError(
        "UPDATE_FEED_INVALID",
        `${channel}.current is not an immutable release-set id`,
      );
    }
    return { releaseSet: current, generation: snapshot.generation };
  }

  #verifyEnvelope<T>(bytes: Uint8Array): { value: T; payloadBytes: Uint8Array } {
    let envelope: SignedEnvelope;
    try {
      envelope = JSON.parse(new TextDecoder().decode(bytes)) as SignedEnvelope;
    } catch {
      throw new UpdateError("UPDATE_FEED_INVALID", "signed document is not valid JSON");
    }
    if (
      envelope?.schema_version !== 1 ||
      typeof envelope.key_id !== "string" ||
      typeof envelope.payload !== "string" ||
      typeof envelope.signature !== "string"
    ) {
      throw new UpdateError("UPDATE_FEED_INVALID", "signed document envelope is invalid");
    }
    const key = this.#trustedKeys[envelope.key_id];
    if (!key) throw integrity(`untrusted signing key: ${envelope.key_id}`);
    const signed = Buffer.from(`coforge-release-v1\n${envelope.key_id}\n${envelope.payload}`);
    let valid = false;
    try {
      valid = verify(null, signed, createPublicKey(key), Buffer.from(envelope.signature, "base64"));
    } catch {
      throw integrity("signed document signature is malformed");
    }
    if (!valid) throw integrity("signed document signature is invalid");
    const payloadBytes = Buffer.from(envelope.payload, "base64");
    try {
      return { value: JSON.parse(payloadBytes.toString("utf8")) as T, payloadBytes };
    } catch {
      throw new UpdateError("UPDATE_FEED_INVALID", "signed payload is not valid JSON");
    }
  }

  #assertChannels(value: ChannelSnapshot): void {
    if (
      value?.schema_version !== 1 ||
      !Number.isSafeInteger(value.generation) ||
      value.generation < 0 ||
      !validChannel(value.channels?.production) ||
      !validChannel(value.channels?.test)
    ) {
      throw new UpdateError("UPDATE_FEED_INVALID", "channel snapshot schema is invalid");
    }
  }

  #assertReleaseSet(value: ReleaseSet): void {
    if (
      value?.schema_version !== 1 ||
      !validReference(value.components?.computer) ||
      !validReference(value.components?.daemon) ||
      typeof value.bundles !== "object" ||
      value.bundles === null
    ) {
      throw new UpdateError("UPDATE_FEED_INVALID", "release-set manifest schema is invalid");
    }
  }

  #assertComponentManifest(value: ComponentManifest, component: "computer" | "daemon"): void {
    if (
      value?.schema_version !== 1 ||
      value.component !== component ||
      typeof value.version !== "string" ||
      !validIdentity(value.artifacts?.[this.#target])
    ) {
      throw new UpdateError(
        "UPDATE_FEED_INVALID",
        `${component} manifest schema is invalid for ${this.#target}`,
      );
    }
  }

  #verifyBundle(
    bundle: InstallationBundle,
    components: Record<"computer" | "daemon", { digest: string; manifest: ComponentManifest }>,
  ): Record<"computer" | "daemon", Uint8Array> {
    if (bundle?.schema_version !== 1) {
      throw new UpdateError("UPDATE_FEED_INVALID", "installation bundle schema is invalid");
    }
    const output = {} as Record<"computer" | "daemon", Uint8Array>;
    for (const component of ["computer", "daemon"] as const) {
      const member = bundle[component];
      if (!validIdentity(member) || typeof member.payload !== "string") {
        throw new UpdateError("UPDATE_FEED_INVALID", `${component} bundle member is invalid`);
      }
      if (member.component_manifest_sha256 !== components[component].digest) {
        throw integrity(`${component} bundle member names the wrong component manifest`);
      }
      const payload = Buffer.from(member.payload, "base64");
      const manifestIdentity = components[component].manifest.artifacts[this.#target]!;
      if (!matchesIdentity(payload, member) || !sameIdentity(member, manifestIdentity)) {
        throw integrity(`${component} payload does not match both recorded identities`);
      }
      output[component] = payload;
    }
    return output;
  }

  async #downloadImmutable(
    reference: ComponentReference,
    requiredPrefix: string,
  ): Promise<Uint8Array> {
    if (
      !validReference(reference) ||
      !reference.url.startsWith(requiredPrefix) ||
      !safeRelativePath(reference.url)
    ) {
      throw new UpdateError(
        "UPDATE_FEED_INVALID",
        "immutable artifact URL crosses its declared namespace",
      );
    }
    const bytes = await this.#download(reference.url);
    if (!matchesIdentity(bytes, reference))
      throw integrity(`downloaded artifact failed integrity: ${reference.url}`);
    return bytes;
  }

  async #download(path: string): Promise<Uint8Array> {
    const url = new URL(path, this.#baseUrl);
    if (url.origin !== this.#baseUrl.origin || !url.pathname.startsWith(this.#baseUrl.pathname)) {
      throw new UpdateError("UPDATE_FEED_INVALID", "release URL escapes the configured feed");
    }
    let response: Response;
    try {
      response = await this.#fetch(url);
    } catch {
      throw new UpdateError("UPDATE_FEED_INVALID", `could not download ${path}`);
    }
    if (!response.ok || response.redirected) {
      throw new UpdateError(
        "UPDATE_FEED_INVALID",
        `release object unavailable without a trusted redirect: ${path}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async #installVersion(
    releaseSet: string,
    payloads: Record<"computer" | "daemon", Uint8Array>,
  ): Promise<void> {
    const versionName = releaseSet.slice("sha256:".length);
    const versions = join(this.#installRoot, "versions");
    const destination = join(versions, versionName);
    try {
      await stat(destination);
      await this.#assertInstalled(releaseSet);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof UpdateError) throw error;
        throw integrity("an immutable version directory already exists but is incomplete");
      }
    }
    const staging = join(this.#installRoot, ".staging", `${versionName}-${crypto.randomUUID()}`);
    const computerName = this.#target.startsWith("windows-")
      ? "coforge-computer.exe"
      : "coforge-computer";
    const daemonName = this.#target.startsWith("windows-")
      ? "coforge-daemon.exe"
      : "coforge-daemon";
    const installedIdentity: InstalledIdentity = {
      schema_version: 1,
      release_set: releaseSet,
      computer: { size: payloads.computer.byteLength, sha256: sha256(payloads.computer) },
      daemon: { size: payloads.daemon.byteLength, sha256: sha256(payloads.daemon) },
    };
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      await Promise.all([
        writeFile(join(staging, computerName), payloads.computer, { mode: 0o700 }),
        writeFile(join(staging, daemonName), payloads.daemon, { mode: 0o700 }),
        writeFile(join(staging, "release-set"), `${releaseSet}\n`, { mode: 0o600 }),
        writeFile(join(staging, "installation.json"), `${JSON.stringify(installedIdentity)}\n`, {
          mode: 0o600,
        }),
      ]);
      await mkdir(versions, { recursive: true, mode: 0o700 });
      await rename(staging, destination);
      if (process.platform !== "win32") {
        await Promise.all([
          chmod(join(destination, computerName), 0o700),
          chmod(join(destination, daemonName), 0o700),
        ]);
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async #assertInstalled(releaseSet: string): Promise<void> {
    const version = join(this.#installRoot, "versions", releaseSet.slice("sha256:".length));
    const computerName = this.#target.startsWith("windows-")
      ? "coforge-computer.exe"
      : "coforge-computer";
    const daemonName = this.#target.startsWith("windows-")
      ? "coforge-daemon.exe"
      : "coforge-daemon";
    try {
      const [computer, daemon, marker, identityText] = await Promise.all([
        readFile(join(version, computerName)),
        readFile(join(version, daemonName)),
        readFile(join(version, "release-set"), "utf8"),
        readFile(join(version, "installation.json"), "utf8"),
      ]);
      const identity = JSON.parse(identityText) as InstalledIdentity;
      if (
        marker.trim() !== releaseSet ||
        identity.schema_version !== 1 ||
        identity.release_set !== releaseSet ||
        !validIdentity(identity.computer) ||
        !validIdentity(identity.daemon) ||
        !matchesIdentity(computer, identity.computer) ||
        !matchesIdentity(daemon, identity.daemon)
      ) {
        throw integrity("installed version failed its offline integrity check");
      }
    } catch (error) {
      if (error instanceof UpdateError) throw error;
      throw integrity("installed version metadata or payload is invalid");
    }
  }

  async #activate(state: ActiveState): Promise<void> {
    await this.#writeJsonAtomic("active.json", state);
    await mkdir(this.#binaryDirectory, { recursive: true, mode: 0o700 });
    if (this.#target.startsWith("windows-")) {
      const launcher = [
        "@echo off",
        `for /f "usebackq tokens=*" %%i in (\`powershell -NoProfile -Command "(Get-Content -Raw '${join(this.#installRoot, "active.json").replaceAll("'", "''")}' | ConvertFrom-Json).current.Substring(7)"\`) do set COFORGE_ACTIVE=%%i`,
        `"${join(this.#installRoot, "versions")}\\%COFORGE_ACTIVE%\\coforge-computer.exe" %*`,
        "",
      ].join("\r\n");
      const launcherPath = join(this.#binaryDirectory, "coforge-computer.cmd");
      const temporary = `${launcherPath}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, launcher, { mode: 0o700 });
      await rename(temporary, launcherPath);
      return;
    }
    const activeLink = join(this.#installRoot, "active");
    const temporaryActive = `${activeLink}.${crypto.randomUUID()}.tmp`;
    await symlink(join("versions", state.current.slice("sha256:".length)), temporaryActive, "dir");
    await rename(temporaryActive, activeLink);
    const shim = join(this.#binaryDirectory, "coforge-computer");
    const temporaryShim = `${shim}.${crypto.randomUUID()}.tmp`;
    await symlink(join(this.#installRoot, "active", "coforge-computer"), temporaryShim, "file");
    await rename(temporaryShim, shim);
  }

  async #readJson<T>(relativePath: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(join(this.#installRoot, relativePath), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async #writeJsonAtomic(relativePath: string, value: unknown): Promise<void> {
    const destination = join(this.#installRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = join(this.#installRoot, ".update-lock");
    await mkdir(this.#installRoot, { recursive: true, mode: 0o700 });
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new UpdateError("UPDATE_BUSY", "another install, upgrade, or rollback is running");
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
}

function validIdentity(value: unknown): value is ArtifactIdentity {
  const candidate = value as ArtifactIdentity | undefined;
  return (
    typeof candidate?.size === "number" &&
    Number.isSafeInteger(candidate.size) &&
    candidate.size >= 0 &&
    typeof candidate.sha256 === "string" &&
    RELEASE_SET_PATTERN.test(candidate.sha256)
  );
}

function validReference(value: unknown): value is ComponentReference {
  return validIdentity(value) && typeof (value as ComponentReference).url === "string";
}

function safeRelativePath(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("?") &&
    !value.includes("#") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function validChannel(
  value: unknown,
): value is { current: string | null; previous: string | null } {
  const channel = value as { current?: unknown; previous?: unknown } | undefined;
  return (
    channel !== undefined &&
    (channel.current === null ||
      (typeof channel.current === "string" && RELEASE_SET_PATTERN.test(channel.current))) &&
    (channel.previous === null ||
      (typeof channel.previous === "string" && RELEASE_SET_PATTERN.test(channel.previous)))
  );
}

function matchesIdentity(bytes: Uint8Array, identity: ArtifactIdentity): boolean {
  return bytes.byteLength === identity.size && sha256(bytes) === identity.sha256;
}

function sameIdentity(left: ArtifactIdentity, right: ArtifactIdentity): boolean {
  return left.size === right.size && left.sha256 === right.sha256;
}

function integrity(message: string): UpdateError {
  return new UpdateError("UPDATE_INTEGRITY_FAILED", message);
}
