import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SkillsBenchTask } from "./types";

/**
 * Stages the task's non-skill environment files into the Task Agent's
 * workspace root — its shell cwd. These are execution inputs (data files,
 * fixtures), not knowledge: the skill itself must arrive through the Memory
 * Agent's offer, so nothing is staged into any skills directory.
 */
export async function stageEnvironment(input: {
  task: SkillsBenchTask;
  agentWorkspaceDir: string;
}): Promise<number> {
  let staged = 0;
  for (const file of input.task.envFiles) {
    const dest = join(input.agentWorkspaceDir, file.relPath);
    await mkdir(join(dest, ".."), { recursive: true });
    await cp(file.absPath, dest);
    staged += 1;
  }
  return staged;
}
