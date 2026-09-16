const RELEASE_VERSION = /^[A-Za-z0-9.+-]{1,100}$/;
const SEMVER_VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9A-Za-z][0-9A-Za-z]*)(?:\.(?:0|[1-9A-Za-z][0-9A-Za-z]*))*))?(?:\+([0-9A-Za-z.-]+))?$/;

type Parsed = { core: [number, number, number]; prerelease: string[] };

export function parseReleaseVersion(value: string): Parsed | undefined {
  const match = SEMVER_VERSION.exec(value.trim());
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

export function isValidReleaseVersion(value: string): boolean {
  return (
    RELEASE_VERSION.test(value) && value !== "." && !value.includes("..") && !value.startsWith("-")
  );
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (!a || !b) throw new Error("cannot compare invalid release versions");
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i]! - b.core[i]!;
  if (!a.prerelease.length || !b.prerelease.length) {
    if (!a.prerelease.length && !b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
