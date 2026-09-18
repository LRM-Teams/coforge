import coforgePackage from "../package.json";

/**
 * The running Agent CLI's own version, for `coforge version`/`coforge --version`. Inlined at
 * release build time the same way `COFORGE_DAEMON_VERSION`/`COFORGE_COMPUTER_VERSION` are
 * (`scripts/release/compile-targets.ts`, `scripts/release/build-package.ts`): this package's own
 * `@lrm/coforge` `package.json` version in ordinary dev/test, or the literal release version once
 * `Bun.env.COFORGE_CLI_VERSION` is inlined by `define` into the compiled `coforge-computer`
 * executable's `__agent-cli` entrypoint (`packages/computer/src/main.ts`, which bundles this
 * package's `src/cli.ts` as `@lrm/coforge/runner`).
 */
export const COFORGE_CLI_VERSION = Bun.env.COFORGE_CLI_VERSION ?? coforgePackage.version;
