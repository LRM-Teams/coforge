import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentProfileTab } from "@/features/agents/profile-panel/agent-profile-tab";
import type { AgentRuntimeControls } from "@/features/agents/agent-runtime-controls";
import type { getAgentProfile } from "@/features/agents/agents.functions";

type AgentProfile = NonNullable<Awaited<ReturnType<typeof getAgentProfile>>>;

/** A representative `getAgentProfile` payload; only the fields `AgentProfileTab` actually reads
 * need real values. `canManage` (owner or admin-like) is what the caller derives and passes down
 * separately, but `canManageAgentRole` on the payload itself independently gates the Role pencil. */
function profileFixture(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    workspaceId: "workspace-1",
    name: "builder",
    displayName: "Builder",
    description: "Builds things.",
    role: "member",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    computerId: "computer-1",
    computer: {
      id: "computer-1",
      label: "s144",
      kind: "local",
      computerVersion: "0.1.0-dev.35",
      online: true,
    },
    owner: { id: "user-1", username: "frank-an", displayName: "Frank An" },
    runtimeConfig: {
      runtime: "codex",
      provider: { kind: "coforge", providerId: "openai" },
      model: "gpt-5.1-codex",
      modelProvider: "openai",
      reasoning: "high",
    },
    isWeeklyReportAssistant: false,
    stopped: false,
    status: { value: "active", expiresAt: null, ordering: null },
    latestError: undefined,
    activity: [],
    ownedByCurrentUser: false,
    runtimeCredential: null,
    canManageAgentRole: false,
    canFullResetAgent: false,
    ...overrides,
  } as unknown as AgentProfile;
}

function controlsFixture(isOnline: boolean): AgentRuntimeControls {
  return {
    agentName: "Builder",
    isOnline,
    computerLabel: "s144",
    startPending: false,
    stopPending: false,
    startStopBusy: false,
    startStopError: null,
    startDeferred: false,
    pressStartOrStop: () => {},
    stopConfirmOpen: false,
    setStopConfirmOpen: () => {},
    closeStopConfirm: () => {},
    confirmStop: () => {},
    restartOpen: false,
    setRestartOpen: () => {},
    closeRestart: () => {},
    action: "restart",
    setAction: () => {},
    options: [],
    selected: { action: "restart", label: "Restart", description: "" },
    destructive: false,
    restartSubmitError: null,
    openRestart: () => {},
    submitRestart: () => {},
  } as unknown as AgentRuntimeControls;
}

const noop = async () => {};

test("a member (non-manager) sees a read-only Profile: no pencils, no Actions section", () => {
  const markup = renderToStaticMarkup(
    <AgentProfileTab
      profile={profileFixture()}
      display={undefined}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onGotoActivity={() => {}}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain("Builder");
  expect(markup).toContain("@builder");
  // No edit affordance anywhere in the read-only view.
  expect(markup).not.toContain("Edit display name");
  expect(markup).not.toContain("Edit description");
  // No Actions section for a non-manager.
  expect(markup).not.toContain("Stop agent");
  expect(markup).not.toContain("Restart");
});

test("a manager (owner or admin-like) sees pencils and the Actions section", () => {
  const markup = renderToStaticMarkup(
    <AgentProfileTab
      profile={profileFixture({ ownedByCurrentUser: true })}
      display={undefined}
      timeZone="UTC"
      canManage
      controls={controlsFixture(true)}
      onGotoActivity={() => {}}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      onSaveRole={noop}
      runtimeCredentialDialog={<span data-testid="runtime-dialog-slot" />}
    />,
  );
  expect(markup).toContain("Builder");
  expect(markup).toContain("Edit display name");
  expect(markup).toContain("Edit description");
  // Online Agent: the Actions button reads "Stop agent".
  expect(markup).toContain("Stop agent");
  expect(markup).toContain('data-testid="runtime-dialog-slot"');
});

test("a stopped Agent's Actions section offers Start instead of Stop", () => {
  const markup = renderToStaticMarkup(
    <AgentProfileTab
      profile={profileFixture({ ownedByCurrentUser: true, stopped: true })}
      display={undefined}
      timeZone="UTC"
      canManage
      controls={controlsFixture(false)}
      onGotoActivity={() => {}}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain("Start agent");
  expect(markup).not.toContain("Stop agent");
});
