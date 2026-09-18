import { resolve } from "node:path";

/**
 * Bun.build resolves bare imports from the *importing file's* package, not the
 * entrypoint package. `@lrm/coforge-sdk` imports `zod`, so when
 * `packages/coforge-sdk/node_modules/zod` is missing (incomplete install /
 * pruned link), compile fails even if `packages/computer` has zod linked.
 *
 * Pin the resolve through a package that declares zod so Computer/Daemon
 * fixture and release compiles keep working.
 */
export function zodResolvePlugin(repoRoot: string): Bun.Plugin {
  const fromComputer = resolve(repoRoot, "packages/computer");
  let zodEntry: string;
  try {
    zodEntry = Bun.resolveSync("zod", fromComputer);
  } catch {
    zodEntry = Bun.resolveSync("zod", resolve(repoRoot, "packages/coforge-sdk"));
  }
  return {
    name: "resolve-zod",
    setup(build) {
      build.onResolve({ filter: /^zod$/ }, () => ({ path: zodEntry }));
    },
  };
}
