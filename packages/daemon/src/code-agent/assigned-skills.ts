import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { WEEKLY_REPORT_SKILL_FILES } from "./skills/weekly-report";

export type AssignedSkillPack = "weekly-report";

const PACKS: Record<AssignedSkillPack, Readonly<Record<string, string>>> = {
  "weekly-report": WEEKLY_REPORT_SKILL_FILES,
};

/** Provider-native workspace Skills root for CoForge-assigned packs. */
export function assignedSkillsDirectory(
  provider: RuntimeProvider,
  agentWorkspaceDirectory: string,
): string {
  const cwd = resolve(agentWorkspaceDirectory);
  switch (provider) {
    case "claude-code":
      return join(cwd, ".claude", "skills");
    case "codex":
      return join(cwd, ".agents", "skills");
    case "kiro":
      return join(cwd, ".kiro", "skills");
    case "pi":
    case "coforge":
      return join(cwd, ".pi", "skills");
  }
}

/**
 * Installs CoForge-owned skill packs into the Agent workspace before native
 * discovery. Never overwrites an existing same-named skill directory entry.
 */
export async function installAssignedSkills(options: {
  provider: RuntimeProvider;
  agentWorkspaceDirectory: string;
  packs: readonly AssignedSkillPack[];
}): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = [];
  const skipped: string[] = [];
  const root = assignedSkillsDirectory(options.provider, options.agentWorkspaceDirectory);
  for (const pack of options.packs) {
    const files = PACKS[pack];
    if (!files) continue;
    for (const [skillName, body] of Object.entries(files)) {
      const skillDirectory = join(root, skillName);
      const skillPath = join(skillDirectory, "SKILL.md");
      try {
        await access(skillPath, constants.F_OK);
        skipped.push(skillName);
        continue;
      } catch {
        // Missing skill file is the install path.
      }
      await mkdir(skillDirectory, { recursive: true, mode: 0o700 });
      await writeFile(skillPath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      written.push(skillName);
    }
  }
  return { written, skipped };
}

export function parseAssignedSkillPacks(value: unknown): AssignedSkillPack[] {
  if (!Array.isArray(value)) return [];
  const packs: AssignedSkillPack[] = [];
  for (const entry of value) {
    if (entry === "weekly-report" && !packs.includes(entry)) packs.push(entry);
  }
  return packs;
}
