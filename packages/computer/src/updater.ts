import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { acquireProcessLock } from "@coforge/daemon";
import { runInstallationSource } from "./release/installation-source";

const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
// Matches the pointer file, a version directory, and a manifest.json platform entry: a bare
// version string with no path separators and no traversal segment.
const VERSION_PATTERN = /^[A-Za-z0-9.+-]{1,100}$/;

/** A version is both a URL segment and an on-disk directory name under "versions/", so beyond
 * the character-class pattern above it must reject two further values that pattern alone would
 * accept: "." on its own, which as a directory name means "the versions directory itself" and
 * would let a payload land outside any per-version directory (a lone "." never triggers the
 * "*.." substring check, which only catches two consecutive dots); and a leading "-", which
 * would let the value be mistaken for a flag by curl, a shell, or any other tool it later
 * reaches. Both #assertVersion and rollback() must go through this single function so neither
 * path can drift from the other's notion of "valid". */
function isValidVersion(value: string): boolean {
  return (
    VERSION_PATTERN.test(value) && value !== "." && !value.includes("..") && !value.startsWith("-")
  );
}

type ArtifactIdentity = { size: number; checksum: string };
type PlatformArtifact = ArtifactIdentity & {
  binary: string;
  gzip: ArtifactIdentity & { binary: string };
};

type ReleaseManifest = {
  schema_version: 2;
  version: string;
  commit: string;
  buildDate: string;
  platforms: Record<string, { computer: PlatformArtifact }>;
};

type ActiveState = {
  schema_version: 1;
  current: string;
  previous: string | null;
};

type InstalledIdentity = {
  schema_version: 2;
  version: string;
  computer: ArtifactIdentity;
  agentCli: ArtifactIdentity;
};

export type PreparedUpdate = {
  version: string;
  previous: string | null;
  rollbackVersion?: string | null;
};

export class UpdateError extends Error {
  constructor(
    readonly code:
      | "UPDATE_BUSY"
      | "UPDATE_FEED_INVALID"
      | "UPDATE_INTEGRITY_FAILED"
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
  target: string;
  installRoot: string;
  binaryDirectory?: string;
  localDirectory?: string;
  onStage?: (stage: string) => void;
  quietHeader?: boolean;
}

export interface LockedComputerUpdater {
  prepare(selection: string): Promise<PreparedUpdate>;
  prepareRollback(): Promise<PreparedUpdate>;
  activatePrepared(prepared: PreparedUpdate): Promise<void>;
  restoreVerified(version: string, rollbackVersion: string | null): Promise<void>;
}

export class ComputerUpdater {
  readonly #baseUrl: URL;
  readonly #target: string;
  readonly #installRoot: string;
  readonly #binaryDirectory: string;
  readonly #localDirectory: string | undefined;
  readonly #onStage: (stage: string) => void;
  readonly #quietHeader: boolean;

  constructor(options: ComputerUpdaterOptions) {
    this.#baseUrl = new URL(
      options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
    );
    this.#target = options.target;
    this.#installRoot = options.installRoot;
    this.#binaryDirectory = options.binaryDirectory ?? join(options.installRoot, "bin");
    this.#localDirectory = options.localDirectory;
    this.#onStage = options.onStage ?? (() => {});
    this.#quietHeader = options.quietHeader ?? false;
  }

  async install(selection: string): Promise<{ version: string; previous: string | null }> {
    return this.withExclusiveOperation(async () => {
      const version = await this.resolveVersion(selection);
      const computerBytes = await this.#prepareArtifact(
        version,
        selection === "latest" || selection === "",
      );

      const previousState = await this.#readJson<ActiveState>("active.json");
      await this.#installVersion(version, computerBytes);
      const previous =
        previousState?.current === version
          ? previousState.previous
          : (previousState?.current ?? null);
      const active: ActiveState = { schema_version: 1, current: version, previous };
      await this.#activate(active);
      return { version, previous };
    });
  }

  /** Download and verify a candidate without changing the active version. The currently active
   * bytes are also verified here, while its processes are still running, so a coordinator never
   * enters the quiesced phase without an offline rollback target. */
  async prepare(selection: string): Promise<PreparedUpdate> {
    return this.withExclusiveOperation((updater) => updater.prepare(selection));
  }

  async #prepare(selection: string): Promise<PreparedUpdate> {
    const version = await this.resolveVersion(selection);
    const active = await this.#readJson<ActiveState>("active.json");
    if (active?.current) {
      this.#assertVersion(active.current, "active version is invalid");
      await this.#assertInstalled(active.current);
    }
    await this.#installVersion(
      version,
      await this.#prepareArtifact(version, selection === "latest" || selection === ""),
    );
    return {
      version,
      previous: active?.current ?? null,
      rollbackVersion: active?.previous ?? null,
    };
  }

  /** Activate only the candidate prepared for the observed active version. */
  async activatePrepared(prepared: PreparedUpdate): Promise<void> {
    await this.withExclusiveOperation((updater) => updater.activatePrepared(prepared));
  }

  async #activatePrepared(prepared: PreparedUpdate): Promise<void> {
    await this.#assertInstalled(prepared.version);
    const active = await this.#readJson<ActiveState>("active.json");
    if ((active?.current ?? null) !== prepared.previous) {
      throw new UpdateError("UPDATE_BUSY", "active version changed after update preparation");
    }
    await this.#activate({
      schema_version: 1,
      current: prepared.version,
      previous:
        prepared.version === prepared.previous
          ? (prepared.rollbackVersion ?? null)
          : prepared.previous,
    });
  }

  /** Verify retained immutable bytes and select them without network access. */
  async restoreVerified(version: string, rollbackVersion: string | null): Promise<void> {
    await this.withExclusiveOperation((updater) =>
      updater.restoreVerified(version, rollbackVersion),
    );
  }

  async #restoreVerified(version: string, rollbackVersion: string | null): Promise<void> {
    this.#assertVersion(version, "rollback version is invalid");
    await this.#assertInstalled(version);
    await this.#activate({ schema_version: 1, current: version, previous: rollbackVersion });
  }

  /** Select and verify the retained previous version without consulting the release feed. */
  async prepareRollback(): Promise<PreparedUpdate> {
    return this.withExclusiveOperation((updater) => updater.prepareRollback());
  }

  async #prepareRollback(): Promise<PreparedUpdate> {
    const active = await this.#readJson<ActiveState>("active.json");
    if (!active?.previous || !isValidVersion(active.previous)) {
      throw new UpdateError("UPDATE_NO_ROLLBACK", "no previous verified version is available");
    }
    await Promise.all([
      this.#assertInstalled(active.current),
      this.#assertInstalled(active.previous),
    ]);
    return { version: active.previous, previous: active.current, rollbackVersion: active.previous };
  }

  async rollback(): Promise<{ version: string; previous: string }> {
    return this.withExclusiveOperation(async () => {
      const active = await this.#readJson<ActiveState>("active.json");
      if (!active?.previous || !isValidVersion(active.previous)) {
        throw new UpdateError("UPDATE_NO_ROLLBACK", "no previous verified version is available");
      }
      await this.#assertInstalled(active.previous);
      const next: ActiveState = {
        schema_version: 1,
        current: active.previous,
        previous: active.current,
      };
      await this.#activate(next);
      return { version: next.current, previous: next.previous! };
    });
  }

  async getCurrentVersion(): Promise<string | null> {
    const active = await this.#readJson<ActiveState>("active.json");
    if (!active) return null;
    this.#assertVersion(active.current, "active version is invalid");
    return active.current;
  }

  /** "latest" (or an omitted CLI selection, which the CLI defaults to "latest") resolves
   * through the feed's pointer file. Anything else must already be a well-formed version
   * string; there is no "test" or "sha256:" selection mode any more. */
  async resolveVersion(selection: string): Promise<string> {
    if (selection === "latest" || selection === "") {
      let version: string;
      try {
        version = await runInstallationSource({
          baseUrl: this.#baseUrl.href,
          target: this.#target,
          selection: "latest",
        });
      } catch (error) {
        throw new UpdateError(
          "UPDATE_FEED_INVALID",
          error instanceof Error ? error.message : String(error),
        );
      }
      this.#assertVersion(version, "latest pointer does not contain a valid version");
      if (version === "latest") {
        throw new UpdateError("UPDATE_FEED_INVALID", "latest pointer must name a concrete version");
      }
      return version;
    }
    this.#assertVersion(selection, "version must be latest or a valid version string");
    return selection;
  }

  #assertVersion(value: string, message: string): void {
    if (!isValidVersion(value)) {
      throw new UpdateError("UPDATE_FEED_INVALID", message);
    }
  }

  #parseManifest(bytes: Uint8Array, expectedVersion: string): ReleaseManifest {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new UpdateError("UPDATE_FEED_INVALID", "manifest is not valid JSON");
    }
    this.#assertManifest(value, expectedVersion);
    return value;
  }

  #assertManifest(value: unknown, expectedVersion: string): asserts value is ReleaseManifest {
    const manifest = value as ReleaseManifest | undefined;
    if (
      manifest?.schema_version !== 2 ||
      typeof manifest.version !== "string" ||
      typeof manifest.commit !== "string" ||
      typeof manifest.buildDate !== "string" ||
      typeof manifest.platforms !== "object" ||
      manifest.platforms === null
    ) {
      throw new UpdateError("UPDATE_FEED_INVALID", "manifest schema is invalid");
    }
    // The manifest is fetched from "<version>/manifest.json", so its own "version" field is
    // redundant unless it is also checked: without this, a feed object served under the wrong
    // version path (a stale cache entry, a misconfigured proxy, or a swapped object) would pass
    // every other check here and only be caught later, if at all, by an unrelated checksum
    // mismatch.
    if (manifest.version !== expectedVersion) {
      throw new UpdateError(
        "UPDATE_FEED_INVALID",
        `manifest version ${manifest.version} does not match requested version ${expectedVersion}`,
      );
    }
    for (const [platformName, entry] of Object.entries(manifest.platforms)) {
      if (!validPlatformEntry(entry)) {
        throw new UpdateError(
          "UPDATE_FEED_INVALID",
          `manifest platform entry for ${platformName} is invalid`,
        );
      }
    }
  }

  async #prepareArtifact(version: string, resolvedLatest: boolean): Promise<Uint8Array> {
    const directory = this.#localDirectory ?? (await mkdtemp(join(tmpdir(), "coforge-candidate-")));
    try {
      if (!this.#localDirectory) {
        await runInstallationSource({
          baseUrl: this.#baseUrl.href,
          target: this.#target,
          selection: version,
          directory,
          quietHeader: resolvedLatest || this.#quietHeader,
          phase: "manifest",
        });
      }
      const manifestFile = Bun.file(join(directory, "manifest.json"));
      if (manifestFile.size > 1024 * 1024)
        throw new UpdateError("UPDATE_FEED_INVALID", "manifest exceeds size limit");
      const manifest = this.#parseManifest(
        new Uint8Array(await manifestFile.arrayBuffer()),
        version,
      );
      const platform = manifest.platforms[this.#target];
      if (!platform)
        throw new UpdateError(
          "UPDATE_UNSUPPORTED_TARGET",
          `manifest has no platform entry for ${this.#target}`,
        );
      if (!this.#localDirectory) {
        await runInstallationSource({
          baseUrl: this.#baseUrl.href,
          target: this.#target,
          selection: version,
          directory,
          quietHeader: true,
          phase: "artifact",
        });
      }
      return await this.#verifyArtifact(directory, platform.computer);
    } catch (error) {
      if (error instanceof UpdateError) throw error;
      throw new UpdateError(
        "UPDATE_FEED_INVALID",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (!this.#localDirectory) await rm(directory, { recursive: true, force: true });
    }
  }

  async #verifyArtifact(directory: string, artifact: PlatformArtifact): Promise<Uint8Array> {
    const download = artifact.gzip;
    const file = Bun.file(join(directory, download.binary));
    if (file.size > download.size)
      throw integrity(`release object is larger than its recorded size: ${download.binary}`);
    if (file.size !== download.size)
      throw integrity(`downloaded artifact failed integrity: ${download.binary}`);
    let bytes = new Uint8Array(await file.arrayBuffer());
    if (!matchesIdentity(bytes, download)) {
      throw integrity(`downloaded artifact failed integrity: ${download.binary}`);
    }
    const reader = new Response(Buffer.from(bytes))
      .body!.pipeThrough(new DecompressionStream("gzip"))
      .getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > artifact.size) throw integrity("decompressed artifact exceeds recorded size");
        chunks.push(chunk.value);
      }
      bytes = Buffer.concat(chunks);
    } catch {
      throw integrity(`compressed artifact is invalid: ${artifact.binary}`);
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!matchesIdentity(bytes, artifact)) {
      throw integrity(`downloaded artifact failed integrity: ${artifact.binary}`);
    }
    return bytes;
  }

  async #installVersion(version: string, computer: Uint8Array): Promise<void> {
    const versions = join(this.#installRoot, "versions");
    const destination = join(versions, version);
    this.#onStage(`Installing CoForge Computer to ${destination}`);
    try {
      await stat(destination);
      await this.#assertInstalled(version);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof UpdateError) throw error;
        throw integrity("an immutable version directory already exists but is incomplete");
      }
    }
    const staging = join(this.#installRoot, ".staging", `${version}-${crypto.randomUUID()}`);
    const computerName = this.#target.startsWith("windows-")
      ? "coforge-computer.exe"
      : "coforge-computer";
    const agentCli = new TextEncoder().encode(
      this.#target.startsWith("windows-")
        ? '@echo off\r\n"%~dp0coforge-computer.exe" __agent-cli %*\r\n'
        : '#!/bin/sh\nexec "${0%/*}/coforge-computer" __agent-cli "$@"\n',
    );
    const installedIdentity: InstalledIdentity = {
      schema_version: 2,
      version,
      computer: { size: computer.byteLength, checksum: checksum(computer) },
      agentCli: { size: agentCli.byteLength, checksum: checksum(agentCli) },
    };
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      await Promise.all([
        writeFile(join(staging, computerName), computer, { mode: 0o700 }),
        writeFile(
          join(staging, this.#target.startsWith("windows-") ? "coforge.cmd" : "coforge"),
          agentCli,
          { mode: 0o700 },
        ),
        writeFile(join(staging, "version"), `${version}\n`, { mode: 0o600 }),
        writeFile(join(staging, "installation.json"), `${JSON.stringify(installedIdentity)}\n`, {
          mode: 0o600,
        }),
      ]);
      await mkdir(versions, { recursive: true, mode: 0o700 });
      await rename(staging, destination);
      if (process.platform !== "win32") {
        await chmod(join(destination, computerName), 0o700);
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async #assertInstalled(version: string): Promise<void> {
    const directory = join(this.#installRoot, "versions", version);
    const computerName = this.#target.startsWith("windows-")
      ? "coforge-computer.exe"
      : "coforge-computer";
    try {
      const [computer, marker, identityText] = await Promise.all([
        readFile(join(directory, computerName)),
        readFile(join(directory, "version"), "utf8"),
        readFile(join(directory, "installation.json"), "utf8"),
      ]);
      const identity = JSON.parse(identityText) as InstalledIdentity;
      if (
        !validIdentity(identity.agentCli) ||
        !matchesIdentity(
          await readFile(
            join(directory, this.#target.startsWith("windows-") ? "coforge.cmd" : "coforge"),
          ),
          identity.agentCli,
        )
      )
        throw integrity("installed Agent CLI failed its offline integrity check");
      if (
        marker.trim() !== version ||
        identity.schema_version !== 2 ||
        identity.version !== version ||
        "daemon" in identity ||
        !validIdentity(identity.computer) ||
        !matchesIdentity(computer, identity.computer)
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
    // 0o755, not the 0o700 used everywhere below `~/.coforge`: the shim directory is a shared
    // conventional location (`~/.local/bin`) that other tools also install into, and a recursive
    // create would otherwise leave `~/.local` itself owner-only for every one of them.
    await mkdir(this.#binaryDirectory, { recursive: true, mode: 0o755 });
    if (this.#target.startsWith("windows-")) {
      const launcher = [
        "@echo off",
        `for /f "usebackq tokens=*" %%i in (\`powershell -NoProfile -Command "(Get-Content -Raw '${join(this.#installRoot, "active.json").replaceAll("'", "''")}' | ConvertFrom-Json).current"\`) do set COFORGE_ACTIVE=%%i`,
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
    await symlink(join("versions", state.current), temporaryActive, "dir");
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

  async withExclusiveOperation<T>(
    operation: (updater: LockedComputerUpdater) => Promise<T>,
  ): Promise<T> {
    await mkdir(this.#installRoot, { recursive: true, mode: 0o700 });
    let lock: ReturnType<typeof acquireProcessLock>;
    try {
      lock = acquireProcessLock(join(this.#installRoot, "machine-mutation-lock.sqlite"));
    } catch (error) {
      if (isLockContention(error)) {
        throw new UpdateError("UPDATE_BUSY", "another install, upgrade, or rollback is running");
      }
      throw error;
    }
    let held = true;
    const assertHeld = () => {
      if (!held) throw new UpdateError("UPDATE_BUSY", "exclusive update operation has ended");
    };
    const updater: LockedComputerUpdater = {
      prepare: async (selection) => {
        assertHeld();
        return this.#prepare(selection);
      },
      prepareRollback: async () => {
        assertHeld();
        return this.#prepareRollback();
      },
      activatePrepared: async (prepared) => {
        assertHeld();
        return this.#activatePrepared(prepared);
      },
      restoreVerified: async (version, rollbackVersion) => {
        assertHeld();
        return this.#restoreVerified(version, rollbackVersion);
      },
    };
    try {
      return await operation(updater);
    } finally {
      held = false;
      lock.release();
    }
  }
}

function isLockContention(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")
  );
}

function checksum(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function validIdentity(value: unknown): value is ArtifactIdentity {
  const candidate = value as ArtifactIdentity | undefined;
  return (
    typeof candidate?.size === "number" &&
    Number.isSafeInteger(candidate.size) &&
    candidate.size >= 0 &&
    typeof candidate.checksum === "string" &&
    CHECKSUM_PATTERN.test(candidate.checksum)
  );
}

/** The binary field is a single path segment appended directly to the download URL and to
 * on-disk paths, so it must not carry a separator or a traversal segment. It is also pinned to
 * the feed's fixed naming (docs/release.md) rather than merely validated as "some safe
 * filename": otherwise a manifest could select an unexpected executable name while retaining a
 * self-consistent checksum. */
function validPlatformEntry(value: unknown): value is { computer: PlatformArtifact } {
  const candidate = value as { computer?: unknown; daemon?: unknown } | undefined;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    Object.keys(candidate).length === 1 &&
    validArtifact(candidate.computer, "coforge-computer")
  );
}

function validArtifact(value: unknown, expectedBinary: string): value is PlatformArtifact {
  const candidate = value as PlatformArtifact | undefined;
  return (
    validIdentity(candidate) &&
    candidate.binary === expectedBinary &&
    validIdentity(candidate.gzip) &&
    candidate.gzip.binary === `${expectedBinary}.gz`
  );
}

function matchesIdentity(bytes: Uint8Array, identity: ArtifactIdentity): boolean {
  return bytes.byteLength === identity.size && checksum(bytes) === identity.checksum;
}

function integrity(message: string): UpdateError {
  return new UpdateError("UPDATE_INTEGRITY_FAILED", message);
}
