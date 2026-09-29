import { getLogger } from "@logtape/logtape";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collapseWhitespace, stripHeadingMarkers } from "#src/code-agent/agent-instructions";

const logger = getLogger(["coforge", "daemon", "agent-runtime", "agent-memory-seed"]);

/** The subset of the server-authored Agent identity (`AgentLaunchIdentity`) the seeded MEMORY.md
 * needs. Declared locally instead of importing that type so this module keeps a narrow,
 * independent seam from the standing-prompt builder. */
export type AgentMemorySeedIdentity = {
  name?: string;
  displayName?: string;
  description?: string;
};

const MEMORY_SOFT_LIMIT_BYTES = 8 * 1024;
const MEMORY_TARGET_KB = 3;

const WORK_LOG_SEED = `# Work log

Chronological history. Append only. Do not read this file every turn — follow the pointer in notes/active-context.md.
`;

const ACTIVE_CONTEXT_SEED = `# Active Context

Before a long task, replace this line with up to 5 lines: the current task, the next step, and pointers to details, so an interrupted task can resume.
`;

const GITIGNORE_SEED = `work/
.pi-sessions/
`;

/**
 * Builds the content of a freshly seeded MEMORY.md for one Agent: a title, a Role section, a
 * Rules slot, and an Index pointing at notes/active-context.md and notes/work-log.md — the
 * directory-card shape the Agent Manual's memory topic tells the Agent to keep for on-demand
 * recovery. MEMORY.md holds references only; the Active Context lives in notes/active-context.md.
 *
 * User-written identity text is sanitised the same way the standing prompt sanitises it: the
 * name is collapsed to a single line so it cannot break the `# <name>` heading, and the
 * description has line-leading `#` characters stripped so it cannot forge extra headings inside
 * the `## Role` section.
 */
export function buildInitialMemoryMd(identity: AgentMemorySeedIdentity): string {
  const rawName = identity.displayName || identity.name;
  const title = rawName ? collapseWhitespace(rawName) : "Agent";
  const description = identity.description?.trim();
  const role = description ? stripHeadingMarkers(description) : "No role defined yet.";
  return `# ${title}

## Role
${role}

## Rules (never change)
-

## Index
- notes/active-context.md   当前任务、下一步、指针（≤5 行）
- notes/work-log.md   按时间的完整历史
`;
}

async function writeNewFile(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return;
    throw error;
  }
}

/** Soft reminder copy when MEMORY.md has grown past the 8KB watch threshold. Daemon never edits the file. */
export async function memoryIndexReminder(
  agentWorkspaceDirectory: string,
): Promise<string | undefined> {
  try {
    const stats = await stat(join(agentWorkspaceDirectory, "MEMORY.md"));
    if (stats.size <= MEMORY_SOFT_LIMIT_BYTES) return undefined;
    const kb = Math.max(1, Math.round(stats.size / 1024));
    return `Your MEMORY.md is ${kb}KB (limit ${MEMORY_TARGET_KB}KB). Move details into notes/ and keep MEMORY.md as an index.`;
  } catch {
    return undefined;
  }
}

/**
 * Writes the seeded MEMORY.md and notes/active-context.md into an Agent's workspace on its first
 * launch, and creates the `notes/` / `work/` layout plus notes/work-log.md and a root
 * `.gitignore`. Never overwrites an existing file — once written, an Agent owns each of them and
 * this seed step never touches it again (`flag: "wx"` fails with `EEXIST`, which is swallowed
 * here). After a Full Reset clears the Agent workspace (the record store's `clearWorkspace`), the
 * files are gone along with every other workspace file, so the next launch's call to this
 * function seeds them again with no special-casing required.
 *
 * Missing directories and notes files are created even when MEMORY.md already exists, so an older
 * workspace still gets the layout, including notes/active-context.md. An existing MEMORY.md is
 * never rewritten, even one that still carries an Active Context section. A seeding failure
 * (anything other than the file already existing) is logged and swallowed: it must never fail the
 * Agent launch that is already under way.
 */
export async function seedAgentMemory(
  agentWorkspaceDirectory: string,
  identity: AgentMemorySeedIdentity,
): Promise<void> {
  const memoryPath = join(agentWorkspaceDirectory, "MEMORY.md");
  const notesDirectory = join(agentWorkspaceDirectory, "notes");
  const workDirectory = join(agentWorkspaceDirectory, "work");
  try {
    // MEMORY.md first: a missing workspace directory fails here with ENOENT and is swallowed,
    // matching the previous seed (it must not mkdir the Agent workspace into existence).
    await writeNewFile(memoryPath, buildInitialMemoryMd(identity));
    await mkdir(notesDirectory, { recursive: true });
    await mkdir(workDirectory, { recursive: true });
    await writeNewFile(join(notesDirectory, "active-context.md"), ACTIVE_CONTEXT_SEED);
    await writeNewFile(join(notesDirectory, "work-log.md"), WORK_LOG_SEED);
    await writeNewFile(join(agentWorkspaceDirectory, ".gitignore"), GITIGNORE_SEED);
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return;
    logger.error("Agent memory seed did not complete", {
      event: "agent_memory_seed:failed",
      agent_workspace_directory: agentWorkspaceDirectory,
      error_code: (error as { code?: string }).code,
    });
  }
}
