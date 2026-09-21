import { constants } from "node:fs";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { WEEKLY_REPORT_SKILL_FILES } from "#src/code-agent/skills/weekly-report";
import { WEEKLY_REPORT_COLLECT_SKILL_FILES } from "#src/code-agent/skills/weekly-report-collect";

export type AssignedSkillPack = "weekly-report" | "weekly-report-collect";

const PACKS: Record<AssignedSkillPack, Readonly<Record<string, string>>> = {
  "weekly-report": WEEKLY_REPORT_SKILL_FILES,
  "weekly-report-collect": WEEKLY_REPORT_COLLECT_SKILL_FILES,
};

/** Marker that this skill directory was written by CoForge and may be synced or removed. */
export const COFORGE_MANAGED_MARKER = ".coforge-managed";

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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Aligns the Agent workspace skill tree with the server-assigned packs. CoForge
 * writes a `.coforge-managed` marker in every directory it owns and:
 * - overwrites a managed skill whose body changed
 * - leaves an Agent-owned same-named directory (no marker) alone
 * - deletes managed directories that are no longer assigned
 */
export async function installAssignedSkills(options: {
  provider: RuntimeProvider;
  agentWorkspaceDirectory: string;
  packs: readonly AssignedSkillPack[];
}): Promise<{ written: string[]; updated: string[]; skipped: string[]; removed: string[] }> {
  const written: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const removed: string[] = [];
  const root = assignedSkillsDirectory(options.provider, options.agentWorkspaceDirectory);
  const wanted = new Map<string, string>();
  for (const pack of options.packs) {
    const files = PACKS[pack];
    if (!files) continue;
    for (const [skillName, body] of Object.entries(files)) wanted.set(skillName, body);
  }

  if (await exists(root)) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || wanted.has(entry.name)) continue;
      const skillDirectory = join(root, entry.name);
      if (!(await exists(join(skillDirectory, COFORGE_MANAGED_MARKER)))) continue;
      await rm(skillDirectory, { recursive: true, force: true });
      removed.push(entry.name);
    }
  }

  for (const [skillName, body] of wanted) {
    const skillDirectory = join(root, skillName);
    const skillPath = join(skillDirectory, "SKILL.md");
    const markerPath = join(skillDirectory, COFORGE_MANAGED_MARKER);
    const already = await exists(skillPath);
    const managed = await exists(markerPath);
    if (already && !managed) {
      skipped.push(skillName);
      continue;
    }
    await mkdir(skillDirectory, { recursive: true, mode: 0o700 });
    await writeFile(skillPath, body, { encoding: "utf8", mode: 0o600 });
    await writeFile(markerPath, "", { encoding: "utf8", mode: 0o600 });
    if (already) updated.push(skillName);
    else written.push(skillName);
  }
  return { written, updated, skipped, removed };
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
