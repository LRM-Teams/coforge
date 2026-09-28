import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { instructionFromBody, listTasks, loadTask } from "../src/tasks";

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

describe("instructionFromBody", () => {
  test("strips YAML frontmatter and keeps the instruction body", () => {
    const task = ["---", "metadata:", "  difficulty: hard", "verifier:", "  type: test-script", "---", "", "You need to do X with /root/input.csv.", ""].join("\n");
    expect(instructionFromBody(task)).toBe("You need to do X with /root/input.csv.");
  });

  test("keeps a bare instruction untouched", () => {
    expect(instructionFromBody("Just do it.")).toBe("Just do it.");
  });
});

describe("loadTask", () => {
  test("reads the current layout: task.md + verifier/ + environment/skills", async () => {
    const root = join(tmpdir(), `sb-tasks-${crypto.randomUUID().slice(0, 8)}`);
    const dir = join(root, "demo");
    await write(
      join(dir, "task.md"),
      ["---", "verifier:", "  type: test-script", "---", "", "Produce /root/out.json.", ""].join("\n"),
    );
    await write(join(dir, "verifier", "test_outputs.py"), "def test_x():\n    assert True\n");
    await write(join(dir, "verifier", "test.sh"), "#!/bin/bash\nexit 0\n");
    await write(join(dir, "environment", "skills", "demo-skill", "SKILL.md"), "# Demo skill\nUse it well.\n");
    await write(join(dir, "environment", "skills", "demo-skill", "scripts", "run.py"), "print('hi')\n");
    await write(join(dir, "environment", "input.dat"), "data");
    await write(join(dir, "environment", "Dockerfile"), "FROM python:3.12\n");

    const task = await loadTask(root, "demo");
    expect(task.instruction).toBe("Produce /root/out.json.");
    expect(task.skills).toHaveLength(1);
    expect(task.skills[0]!.files.map((file) => file.relPath)).toEqual([
      "scripts/run.py",
      "SKILL.md",
    ]);
    expect(task.envFiles.map((file) => file.relPath)).toEqual(["input.dat"]);
    expect(task.testFiles.map((file) => file.relPath).sort()).toEqual(["test.sh", "test_outputs.py"]);
  });

  test("listTasks skips excluded tasks", async () => {
    const root = join(tmpdir(), `sb-list-${crypto.randomUUID().slice(0, 8)}`);
    await write(join(root, "keep-me", "task.md"), "---\n---\nDo keep me.\n");
    await write(join(root, "video-tutorial-indexer", "task.md"), "---\n---\nExcluded.\n");
    expect(await listTasks(root)).toEqual(["keep-me"]);
  });
});
