import { lstat, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { WEEKLY_REPORT_SKILL_FILES } from "#src/code-agent/skills/weekly-report";
import { WEEKLY_REPORT_COLLECT_SKILL_FILES } from "#src/code-agent/skills/weekly-report-collect";
import { LEGACY_ASSIGNED_SKILL_HASHES } from "#src/code-agent/skills/legacy-assigned-skill-hashes";

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
 * discovery. Refreshes unchanged managed files; preserves user-owned edits.
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
    const retired =
      pack === "weekly-report"
        ? ["weekly-report-analysis", "weekly-report-review", "weekly-report-privacy"]
        : [];
    const entries: Array<[string, string | undefined]> = [
      ...Object.entries(files),
      ...retired.map((name): [string, undefined] => [name, undefined]),
    ];
    for (const [skillName, body] of entries) {
      const skillDirectory = join(root, skillName);
      const skillPath = join(skillDirectory, "SKILL.md");
      const markerPath = join(skillDirectory, ".coforge-content-sha256");
      const directory = await existingEntry(skillDirectory);
      if (directory && !directory.isDirectory()) {
        skipped.push(skillName);
        continue;
      }
      const marker = await existingEntry(markerPath);
      if (marker && !marker.isFile()) {
        skipped.push(skillName);
        continue;
      }
      const existing = await existingEntry(skillPath);
      const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
      if (existing) {
        if (!existing.isFile()) {
          skipped.push(skillName);
          continue;
        }
        const content = await Bun.file(skillPath).text();
        const previous = marker ? (await Bun.file(markerPath).text()).trim() : null;
        const unchanged =
          hash(content) === previous ||
          LEGACY_ASSIGNED_SKILL_HASHES[skillName]?.includes(hash(content));
        if (content !== body && !unchanged) {
          skipped.push(skillName);
          continue;
        }
        if (body === undefined) {
          await unlink(skillPath);
          // Preserve other files in a retired skill directory.
          if (await Bun.file(markerPath).exists()) await unlink(markerPath);
          continue;
        }
        if (content === body) {
          await replaceManagedFile(markerPath, hash(body));
          skipped.push(skillName);
          continue;
        }
      }
      if (body === undefined) continue;
      await mkdir(skillDirectory, { recursive: true, mode: 0o700 });
      await replaceManagedFile(skillPath, body);
      await replaceManagedFile(markerPath, hash(body));
      written.push(skillName);
    }
  }
  return { written, skipped };
}

async function existingEntry(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

/** Atomic replacement avoids partial discovery and never follows a file symlink. */
async function replaceManagedFile(path: string, content: string) {
  const temporary = join(dirname(path), `.coforge-${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
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
