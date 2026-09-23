import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { WEEKLY_REPORT_SKILL_FILES } from "#src/code-agent/skills/weekly-report";
import { WEEKLY_REPORT_COLLECT_SKILL_FILES } from "#src/code-agent/skills/weekly-report-collect";

export type AssignedSkillPack = "weekly-report" | "weekly-report-collect";

const PACKS: Record<AssignedSkillPack, Readonly<Record<string, string>>> = {
  "weekly-report": WEEKLY_REPORT_SKILL_FILES,
  "weekly-report-collect": WEEKLY_REPORT_COLLECT_SKILL_FILES,
};

/** Provider-native workspace Skills root for CoForge-assigned packs. */
export function assignedSkillsDirectory(
  provider: RuntimeProvider,
  agentWorkspaceDirectory: string,
): string {
  const cwd = resolve(agentWorkspaceDirectory);
  switch (provider) {
    case RUNTIME_PROVIDER.CLAUDE_CODE:
      return join(cwd, ".claude", "skills");
    case RUNTIME_PROVIDER.CODEX:
      return join(cwd, ".agents", "skills");
    case RUNTIME_PROVIDER.KIRO:
      return join(cwd, ".kiro", "skills");
    case RUNTIME_PROVIDER.CURSOR:
      return join(cwd, ".cursor", "skills");
    case RUNTIME_PROVIDER.OPENCODE:
      return join(cwd, ".opencode", "skills");
    case RUNTIME_PROVIDER.GROK:
      return join(cwd, ".grok", "skills");
    case RUNTIME_PROVIDER.PI:
    case RUNTIME_PROVIDER.COFORGE:
      return join(cwd, ".pi", "skills");
    default: {
      const unreachable: never = provider;
      throw new Error(`Unhandled runtime provider: ${unreachable}`);
    }
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
    if (entry === "weekly-report-collect" && !packs.includes(entry)) packs.push(entry);
  }
  return packs;
}
