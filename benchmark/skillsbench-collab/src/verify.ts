import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { collectExpectedPaths, rewriteTestText } from "./rewrite";
import type { SkillsBenchTask, Verification } from "./types";

const TEST_PY_PATTERN = /^test_.*\.py$/;
/** Matches the skillsbench task schema's verifier timeout (900s). */
const PYTEST_TIMEOUT_MS = Number(Bun.env.COFORGE_EVAL_PYTEST_TIMEOUT_MS ?? "900000");

function pythonBinary(): string {
  return Bun.env.COFORGE_EVAL_PYTHON ?? "python3";
}

function parseTestCounts(output: string): { total: number | null; passed: number; failed: number; skipped: number } {
  const collected = output.match(/collected\s+(\d+)\s+items/);
  const passed = (output.match(/\bPASSED\s+\[/g) ?? []).length;
  const failed = (output.match(/\bFAILED\s+\[/g) ?? []).length;
  const skipped = (output.match(/\bSKIPPED\s+\[/g) ?? []).length;
  let total = collected ? Number(collected[1]) : null;
  if (total === null && (passed || failed || skipped)) total = passed + failed + skipped;
  return { total, passed, failed, skipped };
}

/**
 * Pytest verification, ported from the OpenViking skillsbench evaluator: the
 * Task Agent's workspace (its execution root) is copied into a scratch verify
 * directory, test helpers are copied in with the absolute-path rewrite, the
 * test files themselves are rewritten into the verify root, and pytest runs
 * with cwd = verify root. Score is passed/collected.
 */
export async function runVerification(input: {
  task: SkillsBenchTask;
  agentWorkspaceDir: string;
  verifyBaseDir: string;
}): Promise<Verification & { missingExpectedPaths: string[] }> {
  const verifyDir = join(input.verifyBaseDir, "verify");
  await rm(verifyDir, { recursive: true, force: true });
  await mkdir(verifyDir, { recursive: true });

  // The agent's execution root becomes the pytest root. Dot-directories
  // (.builtin-runtime, .builtin-sessions, ...) hold runtime state, not outputs.
  for (const entry of await readdir(input.agentWorkspaceDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith(".")) continue;
    await cp(join(input.agentWorkspaceDir, entry.name), join(verifyDir, entry.name), {
      recursive: true,
    });
  }

  const testPyFiles = input.task.testFiles.filter(
    (file) => TEST_PY_PATTERN.test(file.relPath.split("/").pop() ?? ""),
  );
  if (testPyFiles.length === 0) {
    return {
      verified: true,
      passed: true,
      testScore: null,
      output: "no pytest files, skipping verification",
      error: null,
      missingExpectedPaths: [],
    };
  }

  const testContents = await Promise.all(
    testPyFiles.map(async (file) => ({ file, content: await readFile(file.absPath, "utf8") })),
  );

  // Helper files ride along at tests/<rel> so the "/tests" rewrite (mapped to
  // the relative "tests") resolves against the pytest cwd, exactly like the
  // OV verifier's tests_dir_relative mapping.
  for (const file of input.task.testFiles) {
    const base = file.relPath.split("/").pop() ?? "";
    if (base === "test_outputs.py" || file.relPath.endsWith(".sh")) continue;
    if (TEST_PY_PATTERN.test(base)) continue;
    const dest = join(verifyDir, "tests", file.relPath);
    await mkdir(dirname(dest), { recursive: true });
    await cp(file.absPath, dest);
    try {
      const text = await readFile(dest, "utf8");
      const rewritten = rewriteTestText(text, { testsDirRelative: "tests", workDir: verifyDir });
      if (rewritten !== text) await writeFile(dest, rewritten, "utf8");
    } catch {
      // binary helper: leave as copied
    }
  }

  // The OV evaluator flattens each rewritten test file into the work root.
  const localTestFiles: string[] = [];
  for (const { file, content } of testContents) {
    const rewritten = rewriteTestText(content, { testsDirRelative: "tests", workDir: verifyDir });
    const base = file.relPath.split("/").pop()!;
    const dest = join(verifyDir, base);
    await writeFile(dest, rewritten, "utf8");
    localTestFiles.push(base);
  }

  // Which /root/... products the tests expect but the agent never produced.
  const missingExpectedPaths: string[] = [];
  for (const full of collectExpectedPaths(testContents.map((row) => row.content))) {
    const rel = full.replace(/^\/(?:root|app)\//, "");
    if (!(await Bun.file(join(verifyDir, rel)).exists())) missingExpectedPaths.push(rel);
  }

  const logsDir = join(verifyDir, "logs", "verifier");
  await mkdir(logsDir, { recursive: true });
  const argv = [
    pythonBinary(),
    "-m",
    "pytest",
    ...localTestFiles,
    "-v",
    "--tb=short",
    "-W",
    "ignore::pytest.PytestCollectionWarning",
    `--junitxml=${join(logsDir, "junit.xml")}`,
  ];
  const child = Bun.spawn(argv, {
    cwd: verifyDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, PYTHONPATH: verifyDir },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), PYTEST_TIMEOUT_MS);
  timer.unref?.();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = `${stdout}${stderr}`;
  const counts = parseTestCounts(output);
  const testScore = counts.total ? Number((counts.passed / counts.total).toFixed(2)) : null;
  return {
    verified: true,
    passed: exitCode === 0,
    testScore,
    output,
    error: exitCode === 0 ? null : `pytest exit ${exitCode}`,
    missingExpectedPaths,
  };
}
