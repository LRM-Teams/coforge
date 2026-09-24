import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import { AgentProfileTab } from "#src/features/agents/profile-panel/agent-profile-tab";
import type { AgentRuntimeControls } from "#src/features/agents/agent-runtime-controls";
import type { getAgentProfile } from "#src/features/agents/agents.functions";
import { formatDateForDisplay } from "#src/lib/dates";
import { m } from "#src/paraglide/messages";

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
    ownedByCurrentUser: false,
    runtimeCredential: null,
    canManageAgentRole: false,
    canFullResetAgent: false,
    runtimeUsageVisible: false,
    visibility: "public",
    canChangeVisibility: false,
    ...overrides,
  } as unknown as AgentProfile;
}

/** The Runtime badge reads cached usage through React Query, so every render gets a client; with
 * `renderToStaticMarkup` no query ever runs. */
function render(node: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>,
  );
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
  const markup = render(
    <AgentProfileTab
      profile={profileFixture()}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain("Builder");
  // No edit affordance anywhere in the read-only view.
  expect(markup).not.toContain("Edit display name");
  expect(markup).not.toContain("Edit description");
  // No Actions section for a non-manager.
  expect(markup).not.toContain("Stop agent");
  expect(markup).not.toContain("Restart");
});

test("the identity block (avatar, name heading, status badge, @handle) is not repeated in the tab body — it lives only in the panel header", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture()}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).not.toContain("@builder");
});

test("a manager (owner or admin-like) sees pencils and the Actions section", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({ ownedByCurrentUser: true })}
      timeZone="UTC"
      canManage
      controls={controlsFixture(true)}
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
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({ ownedByCurrentUser: true, stopped: true })}
      timeZone="UTC"
      canManage
      controls={controlsFixture(false)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain("Start agent");
  expect(markup).not.toContain("Stop agent");
});

test("a viewer without visibility into the runtime's usage sees the plain Runtime badge, no usage button", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({ runtimeUsageVisible: false })}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain("Codex");
  expect(markup).not.toContain("Codex · Usage");
});

test('the runtime\'s owner gets a usage button labelled "<Runtime> · Usage" wrapping the badge', () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({ runtimeUsageVisible: true })}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain('aria-label="Codex · Usage"');
  expect(markup).toContain("Codex");
});

test("a runtime without usage support keeps the plain badge even for its owner", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({
        runtimeUsageVisible: true,
        runtimeConfig: {
          runtime: RUNTIME_PROVIDER.PI,
          provider: { kind: "default" },
          model: "",
          modelProvider: "",
          reasoning: "",
        },
      })}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain("Pi");
  expect(markup).not.toContain('aria-label="Pi · Usage"');
});

test("hides the context-usage badge entirely when there is no reading", () => {
  for (const contextUsage of [undefined, null]) {
    const markup = render(
      <AgentProfileTab
        profile={profileFixture()}
        timeZone="UTC"
        canManage={false}
        controls={controlsFixture(true)}
        onSaveDisplayName={noop}
        onSaveDescription={noop}
        runtimeCredentialDialog={null}
        contextUsage={contextUsage}
      />,
    );
    expect(markup).not.toContain("Context");
  }
});

test("shows the rounded, clamped percentage next to the Runtime badge when a reading is present", () => {
  for (const [usedTokens, windowTokens, expected] of [
    [27_908, 200_000, "Context 14%"],
    [0, 200_000, "Context 0%"],
    // Never guessed above 100% even if a stale window makes usedTokens exceed it.
    [250_000, 200_000, "Context 100%"],
  ] as const) {
    const markup = render(
      <AgentProfileTab
        profile={profileFixture()}
        timeZone="UTC"
        canManage={false}
        controls={controlsFixture(true)}
        onSaveDisplayName={noop}
        onSaveDescription={noop}
        runtimeCredentialDialog={null}
        contextUsage={{
          usedTokens,
          windowTokens,
          observedAtMs: Date.parse("2026-09-18T12:00:00.000Z"),
        }}
      />,
    );
    expect(markup).toContain(expected);
  }
});

test("a manager with a Computer sees the Runtime config pencil", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({ ownedByCurrentUser: true })}
      timeZone="UTC"
      canManage
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      onStartRuntimeEdit={() => {}}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain(m.agent_profile_edit_runtime_config());
});

test("a non-manager never sees the Runtime config pencil", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture()}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      onStartRuntimeEdit={() => {}}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).not.toContain(m.agent_profile_edit_runtime_config());
});

test("an Agent without a Computer shows no Runtime config pencil, even for a manager", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({ ownedByCurrentUser: true, computerId: null, computer: undefined })}
      timeZone="UTC"
      canManage
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      onStartRuntimeEdit={() => {}}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).not.toContain(m.agent_profile_edit_runtime_config());
});

test("the Runtime config pencil never renders when the container gives no onStartRuntimeEdit", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({ ownedByCurrentUser: true })}
      timeZone="UTC"
      canManage
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).not.toContain(m.agent_profile_edit_runtime_config());
});

test("a non-Claude-Code Agent's context badge stays a tooltip trigger, not a popover", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture()}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
      contextUsage={{
        usedTokens: 24_900,
        windowTokens: 200_000,
        observedAtMs: Date.parse("2026-09-18T12:00:00.000Z"),
      }}
    />,
  );
  expect(markup).toContain("Context 12%");
  // No popover trigger/label for a runtime without a composition to read.
  expect(markup).not.toContain(m.agent_context_title());
  expect(markup).not.toContain(`"${m.agent_context_usage_badge({ percent: 12 })}"`);
});

test("a Claude Code Agent's context badge becomes the breakdown popover trigger", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({
        runtimeConfig: {
          runtime: RUNTIME_PROVIDER.CLAUDE_CODE,
          provider: { kind: "default" },
          model: "claude-sonnet-5",
          modelProvider: "",
          reasoning: "high",
        },
      })}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
      contextUsage={{
        usedTokens: 24_900,
        windowTokens: 200_000,
        observedAtMs: Date.parse("2026-09-18T12:00:00.000Z"),
      }}
    />,
  );
  expect(markup).toContain("Context 12%");
  // The popover trigger's accessible label IS the badge's own tooltip line (used / window · time),
  // which is also the popover's header line — the runtime-usage twin's pattern.
  expect(markup).toContain(
    `aria-label="${m.agent_context_usage_tooltip({
      used: "24,900",
      window: "200,000",
      time: formatDateForDisplay(new Date("2026-09-18T12:00:00.000Z"), "UTC", "en"),
    })}"`,
  );
});

test("a viewer who cannot change visibility sees the plain Visibility badge, no change button", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture()}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain("Visibility");
  expect(markup).toContain("Public");
  expect(markup).not.toContain("Make private");
});

test("the creator (or owner/admin) sees the current visibility and a button to change it", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({ visibility: "private", canChangeVisibility: true })}
      timeZone="UTC"
      canManage
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      onRequestVisibilityChange={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain("Private");
  expect(markup).toMatch(/<button[^>]*>(?:(?!<\/button>).)*Make public/);
});

test("a private Agent without the visibility grant shows the Private badge with no edit affordance", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({ visibility: "private", canChangeVisibility: false })}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain("Private");
  expect(markup).not.toContain("Make public");
});
