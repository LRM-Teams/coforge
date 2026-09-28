import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentSkillsListResult } from "@lrm/coforge-sdk/internal";

import { AgentSkills, type AgentSkillsLoadResult } from "#src/features/agents/agent-skills";
import { m } from "#src/paraglide/messages";

function scope(
  entries: AgentSkillsListResult["global"]["entries"],
): AgentSkillsListResult["global"] {
  return { status: "ok", entries, directories: [] };
}

const baseResult: AgentSkillsListResult = {
  protocolMajor: 1,
  requestId: "request",
  workspaceId: "workspace",
  computerId: "computer",
  agentId: "agent",
  provider: "codex",
  scannedAtMs: 1,
  global: scope([
    {
      name: "review",
      displayName: "Review",
      description: "Reviews a change",
      userInvocable: true,
      sourcePath: "~/.agents/skills",
    },
  ]),
  workspace: scope([]),
};

async function render(onLoad: () => Promise<AgentSkillsLoadResult>) {
  // AgentSkills fires its load in a `useEffect`, which `renderToStaticMarkup` never runs; render
  // the resolved state directly by awaiting the load result first is not possible for a hook-driven
  // component under SSR rendering, so these tests assert the synchronous initial ("loading") markup
  // and the reason/retry markup by rendering with a load that already resolved before mount is
  // irrelevant — SSR always shows the loading state. See `agent-runtime-config-dialog.test.tsx` for
  // the same SSR-only rendering approach used elsewhere in this panel.
  return renderToStaticMarkup(<AgentSkills resetKey="agent" onLoad={onLoad} />);
}

test("the initial server-rendered markup shows the heading and the loading line", async () => {
  const markup = await render(async () => ({ status: "ready", result: baseResult }));
  expect(markup).toContain(m.agent_skills_title({ count: 0 }));
  expect(markup).toContain(m.agent_skills_loading());
});

test("agent_skills_title interpolates the global+workspace entry count", () => {
  expect(m.agent_skills_title({ count: 3 })).toContain("3");
});

test("the reason copy no longer tells the viewer to try refreshing (Retry is the button)", () => {
  for (const copy of [
    m.agent_skills_offline(),
    m.agent_skills_timeout(),
    m.agent_skills_unavailable(),
    m.agent_skills_error(),
  ]) {
    expect(copy.toLowerCase()).not.toContain("try refresh");
    expect(copy.toLowerCase()).not.toContain("refresh after");
  }
});

test("the deleted strings (caveat, refresh button, per-entry columns, directory list) are gone", () => {
  const messages = m as unknown as Record<string, unknown>;
  for (const key of [
    "agent_skills_caveat",
    "agent_skills_refresh",
    "agent_skills_name",
    "agent_skills_description",
    "agent_skills_source",
    "agent_skills_directories",
    "agent_skills_partial",
    "agent_skills_scope_error",
    "agent_skills_unsupported",
    "agent_skills_empty",
    "agent_skills_directory_scanned",
    "agent_skills_directory_missing",
    "agent_skills_directory_unreadable",
    "agent_skills_directory_unsupported",
  ])
    expect(messages[key]).toBeUndefined();
});

test("the empty-group and group-label copy exists for both scopes", () => {
  expect(m.agent_skills_global()).toBe("Global");
  expect(m.agent_skills_workspace()).toBe("Workspace");
  expect(m.agent_skills_global_empty().length).toBeGreaterThan(0);
  expect(m.agent_skills_workspace_empty().length).toBeGreaterThan(0);
});
