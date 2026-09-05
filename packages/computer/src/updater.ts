import { chmod, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  schema_version: 1;
  version: string;
  commit: string;
  buildDate: string;
  platforms: Record<string, { computer: PlatformArtifact; daemon: PlatformArtifact }>;
};

type ActiveState = {
  schema_version: 1;
  current: string;
  previous: string | null;
};

type InstalledIdentity = {
  schema_version: 1;
  version: string;
  computer: ArtifactIdentity;
  daemon: ArtifactIdentity;
  agentCli: ArtifactIdentity;
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
  fetch?: typeof globalThis.fetch;
}

export class ComputerUpdater {
  readonly #baseUrl: URL;
  readonly #target: string;
  readonly #installRoot: string;
  readonly #binaryDirectory: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ComputerUpdaterOptions) {
    this.#baseUrl = new URL(
      options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
    );
    this.#target = options.target;
    this.#installRoot = options.installRoot;
    this.#binaryDirectory = options.binaryDirectory ?? join(options.installRoot, "bin");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async install(selection: string): Promise<{ version: string; previous: string | null }> {
    return this.#withLock(async () => {
      const version = await this.#resolveSelection(selection);
      const manifest = this.#parseManifest(
        await this.#download(`${version}/manifest.json`),
        version,
      );
      const platform = manifest.platforms[this.#target];
      if (!platform) {
        throw new UpdateError(
          "UPDATE_UNSUPPORTED_TARGET",
          `manifest has no platform entry for ${this.#target}`,
        );
      }
      const [computerBytes, daemonBytes] = await Promise.all([
        this.#downloadArtifact(version, platform.computer),
        this.#downloadArtifact(version, platform.daemon),
      ]);
      const payloads = { computer: computerBytes, daemon: daemonBytes };

      const previousState = await this.#readJson<ActiveState>("active.json");
      await this.#installVersion(version, payloads);
      const previous =
        previousState?.current === version
          ? previousState.previous
          : (previousState?.current ?? null);
      const active: ActiveState = { schema_version: 1, current: version, previous };
      await this.#activate(active);
      return { version, previous };
    });
  }

  async rollback(): Promise<{ version: string; previous: string }> {
    return this.#withLock(async () => {
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

  /** "latest" (or an omitted CLI selection, which the CLI defaults to "latest") resolves
   * through the feed's pointer file. Anything else must already be a well-formed version
   * string; there is no "test" or "sha256:" selection mode any more. */
  async #resolveSelection(selection: string): Promise<string> {
    if (selection === "latest" || selection === "") {
      const bytes = await this.#download("latest");
      const version = new TextDecoder().decode(bytes).trim();
      this.#assertVersion(version, "latest pointer does not contain a valid version");
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
      manifest?.schema_version !== 1 ||
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

  async #downloadArtifact(version: string, artifact: PlatformArtifact): Promise<Uint8Array> {
    const download = artifact.gzip;
    let bytes = await this.#download(
      `${version}/${this.#target}/${download.binary}`,
      download.size,
    );
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

  async #download(path: string, expectedSize?: number): Promise<Uint8Array> {
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
    // The manifest states the exact size, so a body that exceeds it is already known to be
    // wrong and there is no reason to buffer the rest of it. Without this a malicious or
    // compromised feed could exhaust memory before the checksum check ever runs.
    const declared = Number(response.headers.get("content-length"));
    if (expectedSize !== undefined && Number.isFinite(declared) && declared > expectedSize) {
      throw integrity(`release object is larger than its recorded size: ${path}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (expectedSize !== undefined && bytes.byteLength > expectedSize) {
      throw integrity(`release object is larger than its recorded size: ${path}`);
    }
    return bytes;
  }

  async #installVersion(
    version: string,
    payloads: Record<"computer" | "daemon", Uint8Array>,
  ): Promise<void> {
    const versions = join(this.#installRoot, "versions");
    const destination = join(versions, version);
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
    const daemonName = this.#target.startsWith("windows-")
      ? "coforge-daemon.exe"
      : "coforge-daemon";
    const agentCli = new TextEncoder().encode(
      this.#target.startsWith("windows-")
        ? '@echo off\r\n"%~dp0coforge-daemon.exe" __agent-cli %*\r\n'
        : '#!/bin/sh\nexec "${0%/*}/coforge-daemon" __agent-cli "$@"\n',
    );
    const installedIdentity: InstalledIdentity = {
      schema_version: 1,
      version,
      computer: { size: payloads.computer.byteLength, checksum: checksum(payloads.computer) },
      daemon: { size: payloads.daemon.byteLength, checksum: checksum(payloads.daemon) },
      agentCli: { size: agentCli.byteLength, checksum: checksum(agentCli) },
    };
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      await Promise.all([
        writeFile(join(staging, computerName), payloads.computer, { mode: 0o700 }),
        writeFile(join(staging, daemonName), payloads.daemon, { mode: 0o700 }),
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
        await Promise.all([
          chmod(join(destination, computerName), 0o700),
          chmod(join(destination, daemonName), 0o700),
        ]);
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
    const daemonName = this.#target.startsWith("windows-")
      ? "coforge-daemon.exe"
      : "coforge-daemon";
    try {
      const [computer, daemon, marker, identityText] = await Promise.all([
        readFile(join(directory, computerName)),
        readFile(join(directory, daemonName)),
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
        identity.schema_version !== 1 ||
        identity.version !== version ||
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
 * filename": otherwise a manifest that swapped the two names would pass every other check and
 * only be caught if the swapped checksums happened to differ. */
function validPlatformEntry(
  value: unknown,
): value is { computer: PlatformArtifact; daemon: PlatformArtifact } {
  const candidate = value as { computer?: unknown; daemon?: unknown } | undefined;
  return (
    validArtifact(candidate?.computer, "coforge-computer") &&
    validArtifact(candidate?.daemon, "coforge-daemon")
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
