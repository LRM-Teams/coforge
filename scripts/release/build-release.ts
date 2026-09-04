import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Mirrors packages/computer/src/updater.ts's (module-private) isValidVersion and install.sh's/
// install.ps1's is_valid_version/Test-CoforgeVersion exactly: a version is both a URL segment on
// the feed and an on-disk directory name under `outputDirectory`, published by this script and
// later trusted unread by three different consumers, so the same character class and the same
// two extra rejections apply here first. "." is rejected on its own (in addition to the "*..*"
// traversal check, which does not catch a lone dot) because as a directory name it means "the
// versions directory itself", and a leading "-" is rejected so the value can never be mistaken
// for a flag by a tool it is later passed to. Keeping this as one function, checked before any
// filesystem write below, is what stops a bad version from ever reaching outputDirectory instead
// of only being caught by whichever consumer happens to read it first.
const VERSION_PATTERN = /^[A-Za-z0-9.+-]{1,100}$/;

export function isValidReleaseVersion(value: string): boolean {
  return (
    VERSION_PATTERN.test(value) && value !== "." && !value.includes("..") && !value.startsWith("-")
  );
}

// A release target is also a URL segment and an on-disk directory name (<version>/<target>/...).
// Unlike the version it never comes from outside this repository, so this is a containment check
// rather than a spelling one: it stops a target from escaping the version directory or the URL
// path. A misspelt target is caught upstream by resolveBunCompileTarget, which only accepts the
// six known values and throws otherwise.
const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

function isValidReleaseTarget(value: string): boolean {
  return TARGET_PATTERN.test(value) && !value.includes("..");
}

type ArtifactIdentity = { size: number; checksum: string };
type PlatformArtifact = ArtifactIdentity & { binary: string };

export type ReleaseInputs = {
  version: string;
  commit: string;
  buildDate: string; // ISO 8601
  artifacts: Record<string, { computer: Uint8Array; daemon: Uint8Array }>;
};

export type ReleaseTree = {
  version: string;
  files: string[]; // relative to outputDirectory, forward-slash, sorted
};

/** Writes the whole `<version>/` tree plus `manifest.json` into outputDirectory - everything
 * docs/release.md's feed layout describes except `latest`, which belongs to the publish step
 * (uploading and only then advancing the pointer), not to a build. Producing `latest` here would
 * let a build that never gets uploaded look, on disk, indistinguishable from a published release. */
export async function buildReleaseTree(
  inputs: ReleaseInputs,
  outputDirectory: string,
): Promise<ReleaseTree> {
  if (!isValidReleaseVersion(inputs.version)) {
    throw new Error(`version must be a valid version string: ${inputs.version}`);
  }
  const targets = Object.keys(inputs.artifacts);
  if (targets.length === 0) {
    throw new Error("artifacts must include at least one release target");
  }
  for (const target of targets) {
    if (!isValidReleaseTarget(target)) {
      throw new Error(`invalid release target: ${target}`);
    }
  }

  const versionDirectory = join(outputDirectory, inputs.version);
  await mkdir(versionDirectory, { recursive: true });

  const platforms: Record<string, { computer: PlatformArtifact; daemon: PlatformArtifact }> = {};
  const files: string[] = [];

  for (const target of targets.sort()) {
    const artifact = inputs.artifacts[target];
    if (!artifact) throw new Error(`missing artifact for target: ${target}`);

    // The checksum that goes into the manifest and the checksum that goes into the sidecar are
    // the exact same value, computed exactly once, right here - not two separate sha256() calls
    // that happen to agree today. docs/release.md: "the two must never be allowed to diverge".
    const computerIdentity = artifactIdentity(artifact.computer);
    const daemonIdentity = artifactIdentity(artifact.daemon);
    platforms[target] = {
      computer: { binary: "coforge-computer", ...computerIdentity },
      daemon: { binary: "coforge-daemon", ...daemonIdentity },
    };

    const targetDirectory = join(versionDirectory, target);
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(join(targetDirectory, "coforge-computer"), artifact.computer);
    await writeFile(
      join(targetDirectory, "coforge-computer.sha256"),
      `${computerIdentity.checksum}\n`,
    );
    await writeFile(join(targetDirectory, "coforge-daemon"), artifact.daemon);

    files.push(
      `${inputs.version}/${target}/coforge-computer`,
      `${inputs.version}/${target}/coforge-computer.sha256`,
      `${inputs.version}/${target}/coforge-daemon`,
    );
  }

  // schema_version, version, commit, buildDate, platforms - the shape packages/computer/src/
  // updater.ts's ReleaseManifest type and #assertManifest actually check, not a hand-guessed one.
  const manifest = {
    schema_version: 1 as const,
    version: inputs.version,
    commit: inputs.commit,
    buildDate: inputs.buildDate,
    platforms,
  };
  await writeFile(
    join(versionDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  files.push(`${inputs.version}/manifest.json`);

  return { version: inputs.version, files: files.sort() };
}

function artifactIdentity(bytes: Uint8Array): ArtifactIdentity {
  return { size: bytes.byteLength, checksum: sha256hex(bytes) };
}

function sha256hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
