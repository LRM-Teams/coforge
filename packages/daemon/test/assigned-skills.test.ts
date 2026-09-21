import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignedSkillsDirectory,
  installAssignedSkills,
  parseAssignedSkillPacks,
} from "#src/code-agent/assigned-skills";
import { listAgentSkills } from "#src/code-agent/agent-skills";

/** macOS `TMPDIR` is `/var/folders/...` and `/var` is a symlink to `/private/var`, while the skill
 * scanner rejects any root whose `realpath` differs from its resolved path. Create fixtures under
 * an already-canonical root so the scan sees the directory it was given. */
async function createFixtureRoot(prefix: string): Promise<string> {
  return mkdtemp(join(await realpath(tmpdir()), prefix));
}

test("assigned skill packs install into provider-native workspace roots", async () => {
  const root = await createFixtureRoot("coforge-assigned-skills-");
  try {
    const result = await installAssignedSkills({
      provider: "coforge",
      agentWorkspaceDirectory: root,
      packs: ["weekly-report"],
    });
    expect(result.written).toEqual([
      "weekly-report-navigation",
      "weekly-report-analysis",
      "weekly-report-writing",
      "weekly-report-review",
      "weekly-report-privacy",
    ]);
    expect(result.skipped).toEqual([]);
    expect(assignedSkillsDirectory("coforge", root)).toBe(join(root, ".pi", "skills"));

    const listed = await listAgentSkills({
      provider: "coforge",
      agentWorkspaceDirectory: root,
    });
    expect(listed.workspace.entries.map((entry) => entry.name).sort()).toEqual([
      "weekly-report-analysis",
      "weekly-report-navigation",
      "weekly-report-privacy",
      "weekly-report-review",
      "weekly-report-writing",
    ]);
    expect(JSON.stringify(listed)).not.toContain("Progressive loading");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assigned skill install never overwrites an Agent-owned same-named skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-assigned-skills-skip-"));
  try {
    const skillPath = join(root, ".pi", "skills", "weekly-report-privacy", "SKILL.md");
    await Bun.write(
      skillPath,
      "---\nname: weekly-report-privacy\ndescription: User owned\n---\nKEEP",
    );
    const result = await installAssignedSkills({
      provider: "pi",
      agentWorkspaceDirectory: root,
      packs: ["weekly-report"],
    });
    expect(result.skipped).toContain("weekly-report-privacy");
    expect(await Bun.file(skillPath).text()).toContain("KEEP");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assigned skill sync overwrites a managed skill and deletes a managed leftover", async () => {
  const root = await createFixtureRoot("coforge-assigned-skills-sync-");
  try {
    const first = await installAssignedSkills({
      provider: "coforge",
      agentWorkspaceDirectory: root,
      packs: ["weekly-report"],
    });
    expect(first.written).toContain("weekly-report-privacy");
    const skillDir = join(root, ".pi", "skills", "weekly-report-privacy");
    expect(await Bun.file(join(skillDir, ".coforge-managed")).text()).toBe("");
    await Bun.write(join(skillDir, "SKILL.md"), "STALE");

    const leftover = join(root, ".pi", "skills", "old-managed");
    await Bun.write(join(leftover, "SKILL.md"), "gone");
    await Bun.write(join(leftover, ".coforge-managed"), "");
    const agentOwned = join(root, ".pi", "skills", "my-own-skill");
    await Bun.write(join(agentOwned, "SKILL.md"), "KEEP ME");

    const second = await installAssignedSkills({
      provider: "coforge",
      agentWorkspaceDirectory: root,
      packs: ["weekly-report"],
    });
    expect(second.updated).toContain("weekly-report-privacy");
    expect(second.removed).toEqual(["old-managed"]);
    expect(await Bun.file(join(skillDir, "SKILL.md")).text()).not.toContain("STALE");
    expect(await Bun.file(join(agentOwned, "SKILL.md")).text()).toBe("KEEP ME");
    expect(await Bun.file(join(leftover, "SKILL.md")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty pack list still deletes leftover managed skills", async () => {
  const root = await createFixtureRoot("coforge-assigned-skills-empty-");
  try {
    await installAssignedSkills({
      provider: "coforge",
      agentWorkspaceDirectory: root,
      packs: ["weekly-report"],
    });
    const empty = await installAssignedSkills({
      provider: "coforge",
      agentWorkspaceDirectory: root,
      packs: [],
    });
    expect(empty.removed.length).toBeGreaterThan(0);
    expect(
      await Bun.file(join(root, ".pi", "skills", "weekly-report-privacy", "SKILL.md")).exists(),
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assignedSkillsDirectory places Cursor packs under .cursor/skills", () => {
  expect(assignedSkillsDirectory("cursor", "/workspace")).toBe(
    join("/workspace", ".cursor", "skills"),
  );
});

test("parseAssignedSkillPacks accepts only known packs", () => {
  expect(parseAssignedSkillPacks(["weekly-report", "weekly-report", "other"])).toEqual([
    "weekly-report",
  ]);
  expect(parseAssignedSkillPacks(undefined)).toEqual([]);
});
