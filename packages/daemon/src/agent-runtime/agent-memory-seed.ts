import { getLogger } from "@logtape/logtape";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collapseWhitespace, stripHeadingMarkers } from "../code-agent/agent-instructions";

const logger = getLogger(["coforge", "daemon", "agent-runtime", "agent-memory-seed"]);

/** The subset of the server-authored Agent identity (`AgentLaunchIdentity`) the seeded MEMORY.md
 * needs. Declared locally instead of importing that type so this module keeps a narrow,
 * independent seam from the standing-prompt builder. */
export type AgentMemorySeedIdentity = {
  name?: string;
  displayName?: string;
  description?: string;
};

/**
 * Builds the content of a freshly seeded MEMORY.md for one Agent: a title, a Role section, an
 * empty Key Knowledge index, and an Active Context marking first startup — the structure the
 * standing prompt's "Workspace & Memory" section tells the Agent to keep.
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

## Key Knowledge
- No notes yet.

## Active Context
- First startup.
`;
}

/**
 * Writes the seeded MEMORY.md into an Agent's workspace on its first launch. Never overwrites an
 * existing file — once written, an Agent owns MEMORY.md and this seed step never touches it
 * again (`flag: "wx"` fails with `EEXIST`, which is swallowed here). After a Full Reset clears
 * the Agent workspace (the record store's `clearWorkspace`), MEMORY.md is
 * gone along with every other workspace file, so the next launch's call to this function seeds it
 * again with no special-casing required.
 *
 * A seeding failure (anything other than the file already existing) is logged and swallowed: it
 * must never fail the Agent launch that is already under way.
 */
export async function seedAgentMemory(
  agentWorkspaceDirectory: string,
  identity: AgentMemorySeedIdentity,
): Promise<void> {
  const memoryPath = join(agentWorkspaceDirectory, "MEMORY.md");
  try {
    await writeFile(memoryPath, buildInitialMemoryMd(identity), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return;
    logger.error("Agent memory seed did not complete", {
      event: "agent_memory_seed:failed",
      agent_workspace_directory: agentWorkspaceDirectory,
      error_code: (error as { code?: string }).code,
    });
  }
}
