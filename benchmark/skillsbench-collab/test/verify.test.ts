import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerification } from "../src/verify";
import type { SkillsBenchTask } from "../src/types";

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

import { dirname } from "node:path";

test("runVerification copies the agent workspace and scores the rewritten pytest", async () => {
  const root = await mkdir(join(tmpdir(), `sb-verify-${crypto.randomUUID().slice(0, 8)}`), {
    recursive: true,
  }).then(() => join(tmpdir(), "sb-verify-latest"));

  const taskDir = join(root, "task");
  const agentWorkspace = join(root, "agent-workspace");
  const verifyBase = join(root, "verifybase");

  // A task whose test reads the agent's product via an absolute /root path and
  // imports a helper through /tests.
  await write(join(taskDir, "tests", "test_outputs.py"), [
    "import sys",
    "sys.path.insert(0, '/tests/src')",
    "from checker import read_product",
    "",
    "def test_product():",
    "    assert read_product('/root/output/result.txt') == 'done'",
    "",
  ].join("\n"));
  await write(join(taskDir, "tests", "src", "checker.py"), [
    "def read_product(path):",
    "    path = path.replace('/root/', '')",
    "    with open(path) as handle:",
    "        return handle.read().strip()",
    "",
  ].join("\n"));

  const task: SkillsBenchTask = {
    name: "fixture-task",
    dir: taskDir,
    instruction: "Produce /root/output/result.txt containing done.",
    skills: [],
    envFiles: [],
    testFiles: [
      { relPath: "test_outputs.py", absPath: join(taskDir, "tests", "test_outputs.py") },
      { relPath: "src/checker.py", absPath: join(taskDir, "tests", "src", "checker.py") },
    ],
  };

  // The agent "executed": it wrote the product at its workspace root.
  await write(join(agentWorkspace, "output", "result.txt"), "done\n");
  // Runtime state that must not leak into the verify copy.
  await write(join(agentWorkspace, ".builtin-runtime", "settings.json"), "{}\n");

  const verification = await runVerification({ task, agentWorkspaceDir: agentWorkspace, verifyBaseDir: verifyBase });

  expect(verification.verified).toBe(true);
  expect(verification.passed).toBe(true);
  expect(verification.testScore).toBe(1);
  expect(verification.missingExpectedPaths).toEqual([]);
  // The verify copy keeps the produced file but drops runtime dot-directories.
  const verifyCopy = join(verifyBase, "verify");
  expect(await Bun.file(join(verifyCopy, "output", "result.txt")).text()).toBe("done\n");
  expect(await Bun.file(join(verifyCopy, ".builtin-runtime", "settings.json")).exists()).toBe(false);
}, 120_000);

test("runVerification reports missing expected products and a failed pytest", async () => {
  const stamp = crypto.randomUUID().slice(0, 8);
  const root = join(tmpdir(), `sb-verify-fail-${stamp}`);
  const taskDir = join(root, "task");
  const agentWorkspace = join(root, "agent-workspace");
  const verifyBase = join(root, "verifybase");

  await write(join(taskDir, "tests", "test_outputs.py"), [
    "def test_missing():",
    "    with open('/root/output/result.txt') as handle:",
    "        assert handle.read().strip() == 'done'",
    "",
  ].join("\n"));

  const task: SkillsBenchTask = {
    name: "fixture-task-empty",
    dir: taskDir,
    instruction: "Produce /root/output/result.txt.",
    skills: [],
    envFiles: [],
    testFiles: [{ relPath: "test_outputs.py", absPath: join(taskDir, "tests", "test_outputs.py") }],
  };
  await mkdir(agentWorkspace, { recursive: true });

  const verification = await runVerification({ task, agentWorkspaceDir: agentWorkspace, verifyBaseDir: verifyBase });

  expect(verification.passed).toBe(false);
  expect(verification.testScore ?? 0).toBeLessThan(1);
  expect(verification.missingExpectedPaths).toContain("output/result.txt");
}, 120_000);
