import { join, resolve } from "node:path";
import { resolveServerUrl } from "../../packages/computer/src/release-channel";

// The release target names this repository already uses across docs/release.md, updater.ts's
// manifest.platforms keys and install.sh's/install.ps1's `uname`/architecture switch, mapped to
// the `Bun.build({ compile: { target } })` string that actually cross-compiles each one. Verified
// against Bun 1.4.0 by compiling this repository's own entrypoints for every target below and
// confirming a real ELF/PE binary for the right architecture came out (see the CR description);
// `bun-windows-arm64` in particular is easy to assume unsupported and is not.
const BUN_COMPILE_TARGETS = {
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64",
  "darwin-arm64": "bun-darwin-arm64",
  "windows-x64": "bun-windows-x64",
  "windows-arm64": "bun-windows-arm64",
} as const satisfies Record<string, `bun-${string}`>;

export type ReleaseTarget = keyof typeof BUN_COMPILE_TARGETS;

export function isReleaseTarget(value: string): value is ReleaseTarget {
  return Object.hasOwn(BUN_COMPILE_TARGETS, value);
}

/** Throws on an unsupported target instead of returning undefined, so a typo in a target name
 * fails at the call site instead of three files downstream as a manifest silently missing a
 * platform. */
export function resolveBunCompileTarget(
  target: string,
): (typeof BUN_COMPILE_TARGETS)[ReleaseTarget] {
  if (!isReleaseTarget(target)) {
    throw new Error(`unsupported release target: ${target}`);
  }
  return BUN_COMPILE_TARGETS[target];
}

const REPO_ROOT = resolve(import.meta.dir, "../..");
const COMPUTER_ENTRYPOINT = join(REPO_ROOT, "packages/computer/src/main.ts");

export type CompileTargetOptions = {
  target: ReleaseTarget;
  version: string;
  feedUrl: string;
  /** Directory the unified binary is written into; each target's compile call needs its
   * own directory or scratch file name to avoid two targets racing on the same output path. */
  outputDirectory: string;
};

export type CompiledArtifacts = { computer: Uint8Array };

/** Cross-compiles the unified release binary for one target.
 * compile-targets.test.ts executes the host-target Computer to verify its release identity;
 * build-release.test.ts covers manifest assembly using small fixture binaries. */
export async function compileTargetArtifacts(
  options: CompileTargetOptions,
): Promise<CompiledArtifacts> {
  const bunTarget = resolveBunCompileTarget(options.target);
  const serverUrl = resolveServerUrl(options.feedUrl);
  const computer = await compileOne({
    entrypoint: COMPUTER_ENTRYPOINT,
    bunTarget,
    outfile: join(options.outputDirectory, `${options.target}-coforge-computer`),
    // Bun.build()'s `env` option, verified against Bun 1.4.0, does inline a variable that is
    // actually set in the process running the build - but stays a *live runtime lookup* in the
    // compiled binary when that variable is unset at build time (the exact case the spec's
    // "runtime can still override it" concern describes: a build invoked without the variable
    // exported would silently keep resolving it at install time instead of failing to build).
    // `define` cannot degrade that way: it always inlines the literal given here, so a release
    // build can never accidentally ship a binary that still trusts whatever feed URL happens to
    // be in its environment at update time.
    define: {
      "process.env.COFORGE_RELEASE_FEED_URL": JSON.stringify(options.feedUrl),
      "process.env.COFORGE_E2E_ALLOW_DEVICE_AUTH": JSON.stringify("0"),
      "Bun.env.COFORGE_COMPUTER_VERSION": JSON.stringify(options.version),
      "process.env.COFORGE_DAEMON_VERSION": JSON.stringify(options.version),
      "process.env.COFORGE_DAEMON_SERVER_URL": JSON.stringify(serverUrl),
    },
  });
  return { computer };
}

async function compileOne(options: {
  entrypoint: string;
  bunTarget: string;
  outfile: string;
  define: Record<string, string>;
}): Promise<Uint8Array> {
  const result = await Bun.build({
    entrypoints: [options.entrypoint],
    compile: { target: options.bunTarget as Bun.Build.CompileTarget, outfile: options.outfile },
    define: options.define,
  });
  if (!result.success) {
    throw new Error(
      `bun build failed for ${options.entrypoint} (${options.bunTarget}): ${result.logs
        .map(String)
        .join("; ")}`,
    );
  }
  const output = result.outputs[0];
  if (!output) {
    throw new Error(
      `bun build produced no output for ${options.entrypoint} (${options.bunTarget})`,
    );
  }
  // Bun appends ".exe" to a windows compile target's outfile regardless of what extension was
  // requested, so the path actually written (output.path) is read back here rather than trusting
  // the outfile this function asked for.
  return new Uint8Array(await Bun.file(output.path).arrayBuffer());
}
