import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Bun discovers test files by name (`*.test.*`, `*_test_*`, `*.spec.*`, `*_spec_*`) and treats any
 * other argument as a filter over what it discovered. Two mistakes therefore end in the same silent
 * success — "no matches" and exit 0, with nothing run:
 *
 * - a file Bun will not discover (`.integration.ts`, `.e2e.ts`) named without `./`, which is then a
 *   filter over the discovered set and matches nothing;
 * - a path that does not exist, with or without `./`.
 *
 * Every test file a repository command names is checked here, so neither can pass unnoticed. The
 * commands are the ones CI and the agents actually run: `mise.toml` tasks, `scripts/**.sh`, and the
 * workflow steps.
 */
const DISCOVERABLE = /(?:\.test|_test_|\.spec|_spec_)\.[cm]?tsx?$/;
const SEPARATORS = new Set(["&&", "||", ";", "|", "&"]);
const TAKES_VALUE = new Set([
  "--test-name-pattern",
  "-t",
  "--preload",
  "--timeout",
  "--max-concurrency",
  "--rerun-each",
  "--reporter",
]);

type Invocation = { source: string; token: string; resolved: string };

const root = (path: string) => join(import.meta.dir, "../..", path);

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else if (entry.name.endsWith(".sh")) found.push(path);
  }
  return found;
}

/** The `bun test <args>` tokens of one shell command, quotes and separators removed, with the
 * working directory the shell stands in when it reaches them (a `cd` in the same command). */
function testTokens(command: string, startingCwd: string): { token: string; cwd: string }[] {
  const tokens: { token: string; cwd: string }[] = [];
  let cwd = startingCwd;
  const words = command
    .replace(/\n/g, " ")
    .replace(/\\\s*\n/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (SEPARATORS.has(words[i - 1] ?? "") || i === 0) {
      // `cd <dir>` in the same command moves the shell for the tokens after it.
      if (words[i] === "cd" && words[i + 1] && !SEPARATORS.has(words[i + 1]!))
        cwd = resolveDir(words[i + 1]!, cwd);
    }
    if (words[i] !== "test" || words[i - 1]?.split("/").pop() !== "bun") continue;
    for (let j = i + 1; j < words.length; j++) {
      const word = words[j]!;
      if (SEPARATORS.has(word) || word.startsWith(">") || word.startsWith("<")) break;
      if (word.startsWith("-")) {
        if (TAKES_VALUE.has(word)) j++;
        continue;
      }
      tokens.push({ token: word, cwd });
    }
  }
  return tokens;
}

/** The directory a `cd` names, relative to the repository root. */
function resolveDir(dir: string, cwd: string): string {
  let path = dir.replace(/\$\{?root\}?/g, ".").replace(/^["']|["']$/g, "");
  if (path.startsWith("/")) return path;
  path = path.startsWith("./") ? path.slice(2) : path;
  return cwd === "." ? path : `${cwd}/${path}`;
}

/** `{{vars.x}}` from `mise.toml`, and `$root`/`${root}` as the repository root. */
function expand(token: string, vars: Record<string, string>): string | undefined {
  let expanded = token.replace(/\$\{?root\}?/g, ".");
  expanded = expanded.replace(/\{\{\s*vars\.([A-Za-z0-9_]+)\s*\}\}/g, (_match, name: string) => {
    if (vars[name] === undefined) throw new Error(`unknown mise var: ${name}`);
    return vars[name]!;
  });
  if (/\$\{?[A-Za-z_]/.test(expanded) || expanded.includes("{{")) return undefined;
  return expanded;
}

const uncommented = (line: string) => line.replace(/(^|\s)#.*$/, "");

async function commands(): Promise<{ source: string; command: string }[]> {
  const found: { source: string; command: string }[] = [];
  const mise = Bun.TOML.parse(await Bun.file(root("mise.toml")).text()) as {
    tasks: Record<string, { run: string }>;
  };
  for (const [name, task] of Object.entries(mise.tasks))
    found.push({ source: `mise.toml#${name}`, command: task.run });
  for (const path of await walk(root("scripts"))) {
    let cwd = ".";
    for (const line of (await Bun.file(path).text()).split("\n")) {
      const cd = /^\s*cd\s+([^\s;&|]+)/.exec(uncommented(line));
      if (cd) cwd = resolveDir(cd[1]!, cwd);
      if (line.includes("bun test"))
        found.push({
          source: relative(root("."), path),
          command: `${line} __cwd=${cwd}`,
        });
    }
  }
  for (const file of await readdir(root(".github/workflows"))) {
    if (!file.endsWith(".yml")) continue;
    const workflow = Bun.YAML.parse(await Bun.file(root(`.github/workflows/${file}`)).text()) as {
      jobs?: Record<string, { steps?: { run?: string }[] }>;
    };
    for (const [job, definition] of Object.entries(workflow.jobs ?? {}))
      for (const step of definition.steps ?? [])
        if (step.run?.includes("bun test"))
          found.push({ source: `.github/workflows/${file}#${job}`, command: step.run });
  }
  return found;
}

test("every test file a repository command names exists, and a file Bun will not discover is a path", async () => {
  const vars = (
    Bun.TOML.parse(await Bun.file(root("mise.toml")).text()) as {
      vars: Record<string, string>;
    }
  ).vars;
  const checked: Invocation[] = [];
  const missing: string[] = [];
  const filtered: string[] = [];

  for (const { source, command } of await commands()) {
    const sentinel = / __cwd=(\S+)$/.exec(command);
    const startingCwd = sentinel?.[1] ?? ".";
    for (const { token, cwd } of testTokens(
      uncommented(command.replace(/ __cwd=\S+$/, "")),
      startingCwd,
    )) {
      if (!/\.tsx?$/.test(token)) continue;
      const path = expand(token, vars);
      if (path === undefined) continue;
      // A `./` path resolves where the shell stands; an absolute one resolves as it is.
      const resolved =
        path.startsWith("/") || path.startsWith("{{") ? path : join(cwd, path.replace(/^\.\//, ""));
      checked.push({ source, token, resolved });
      if (!(await Bun.file(root(resolved)).exists())) missing.push(`${source}: ${token}`);
      const isPath = path.startsWith("./") || path.startsWith("../") || path.startsWith("/");
      if (!DISCOVERABLE.test(path) && !isPath) filtered.push(`${source}: ${token}`);
    }
  }

  // The check must look at real commands, not an empty set that passes for the wrong reason.
  expect(checked.length).toBeGreaterThan(10);
  expect(new Set(checked.map((entry) => entry.source.split("#")[0]))).toContain("mise.toml");
  expect(checked.some((entry) => entry.source.startsWith("scripts/"))).toBe(true);

  expect(missing).toEqual([]);
  expect(filtered).toEqual([]);
});
