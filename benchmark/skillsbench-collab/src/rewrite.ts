/**
 * Path-rewrite logic ported from
 * OpenViking/benchmark/skillsbench/skill_bench_eval.py (run_task's instruction
 * rewrite and run_verification's test rewriting). The agent executes at its
 * workspace root, so every absolute "/root" reference becomes workspace-root
 * relative, exactly like the OpenViking evaluator mapped them onto its
 * storage workspace.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `(^|(?<=[\s'"`(\[]))SRC(?=($|[\s'"`)\]]))` — whole-token absolute path match. */
export function replaceAbsToken(text: string, src: string, dst: string): string {
  const pattern = new RegExp(`(^|(?<=[\\s'"\\\`(\[]))${escapeRegExp(src)}(?=($|[\\s'"\\\`)\\]]))`, "gm");
  return text.replace(pattern, (_match, leading: string) => `${leading}${dst}`);
}

/** `(^|(?<=[\s'"`(\[]))SRC` — prefix match (trailing path content stays). */
export function replaceAbsPrefix(text: string, src: string, dst: string): string {
  const pattern = new RegExp(`(^|(?<=[\\s'"\\\`(\[]))${escapeRegExp(src)}`, "gm");
  return text.replace(pattern, (_match, leading: string) => `${leading}${dst}`);
}

/** instruction.md rewrite: `/root/` loses its prefix so paths become relative
 * to the agent's workspace root. */
export function rewriteInstruction(instruction: string): string {
  return instruction.replace(/(^|(?<=[\s'"`(\[]))\/root\//gm, "$1");
}

export type RewriteTestOptions = {
  /** Path of the task's tests directory relative to the pytest cwd. */
  testsDirRelative: string;
  /** The pytest cwd, used for sys.path.insert / cwd= rewrites. */
  workDir: string;
};

export function rewriteTestText(text: string, options: RewriteTestOptions): string {
  const { testsDirRelative, workDir } = options;
  const absTokenMap: Record<string, string> = {
    "/root": "",
    "/app": "",
    "/workspace": "./workspace",
    "/output": "./output",
    "/data": "./data",
    "/logs": "./logs",
    "/tests": testsDirRelative,
  };
  const absPrefixMap: Record<string, string> = {
    "/root/": "",
    "/app/": "",
    "/workspace/": "./workspace/",
    "/output/": "./output/",
    "/data/": "./data/",
    "/logs/": "./logs/",
    "/tests/": `${testsDirRelative}/`,
  };
  let rewritten = text;
  for (const [src, dst] of Object.entries(absTokenMap)) {
    rewritten = replaceAbsToken(rewritten, src, dst);
  }
  for (const [src, dst] of Object.entries(absPrefixMap)) {
    rewritten = replaceAbsPrefix(rewritten, src, dst);
  }
  const literalReplacements: Array<[string, string]> = [
    ['sys.path.insert(0, "/tests/src")', `sys.path.insert(0, "${testsDirRelative}/src")`],
    ["sys.path.insert(0, '/tests/src')", `sys.path.insert(0, '${testsDirRelative}/src')`],
    ['sys.path.insert(0, "/root/workspace")', `sys.path.insert(0, "${workDir}")`],
    ["sys.path.insert(0, '/root/workspace')", `sys.path.insert(0, '${workDir}')`],
    ['sys.path.insert(0, "/root")', `sys.path.insert(0, "${workDir}")`],
    ["sys.path.insert(0, '/root')", `sys.path.insert(0, '${workDir}')`],
    ["cwd='/root'", `cwd='${workDir}'`],
    ['cwd="/root"', `cwd="${workDir}"`],
  ];
  for (const [src, dst] of literalReplacements) {
    rewritten = rewritten.split(src).join(dst);
  }
  return rewritten;
}

/** Absolute /root/... or /app/... literals referenced by test files, mirroring
 * the OpenViking verifier's expected-path collection. */
export function collectExpectedPaths(testContents: readonly string[]): string[] {
  const expected = new Set<string>();
  for (const content of testContents) {
    for (const match of content.matchAll(/['"]((?:\/root|\/app)\/[^'"]+)['"]/g)) {
      const full = match[1]!;
      if (full.endsWith("/")) continue;
      expected.add(full);
    }
  }
  return [...expected].sort();
}
