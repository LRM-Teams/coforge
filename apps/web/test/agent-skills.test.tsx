import "./dom-setup";

import { expect, mock, test } from "bun:test";
import { render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentSkills } from "@/features/agents/agent-skills";

const ready = {
  status: "ready" as const,
  result: {
    protocolMajor: 1,
    requestId: "request-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    provider: "codex" as const,
    scannedAtMs: 1,
    global: {
      status: "ok" as const,
      entries: [
        {
          name: "Review",
          description: "Review changes",
          sourcePath: "~/.agents/skills/review/SKILL.md",
        },
      ],
      directories: [{ path: "~/.agents/skills", status: "scanned" as const }],
    },
    workspace: {
      status: "partial" as const,
      entries: [
        {
          name: "Deploy",
          description: "Deploy CoForge",
          sourcePath: ".agents/skills/deploy/SKILL.md",
        },
      ],
      directories: [{ path: ".agents/skills", status: "unreadable" as const }],
    },
  },
};

test("loads and presents Global and Workspace skill metadata", async () => {
  const load = mock(async () => ready);
  render(<AgentSkills resetKey="agent-1:computer-1:codex" onLoad={load} />);

  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  expect(within(document.body).getByRole("heading", { name: "Global Skills" })).toBeTruthy();
  expect(within(document.body).getByRole("cell", { name: "Review" })).toBeTruthy();
  expect(within(document.body).getByRole("heading", { name: "Workspace Skills" })).toBeTruthy();
  expect(within(document.body).getByRole("cell", { name: "Deploy" })).toBeTruthy();
  expect(document.body.textContent).toContain("Directory metadata, not session loading status");
  expect(document.body.textContent).toContain("Some directories or files could not be read");

  await userEvent.click(within(document.body).getAllByText("Directories")[0]!);
  expect(document.body.textContent).toContain("~/.agents/skills");
});

test("discards a stale response after the assignment changes", async () => {
  let resolveFirst!: (value: typeof ready) => void;
  const first = new Promise<typeof ready>((resolve) => (resolveFirst = resolve));
  const next = structuredClone(ready);
  next.result.agentId = "agent-2";
  next.result.global.entries[0]!.name = "Current skill";
  const load = mock(() => (load.mock.calls.length === 1 ? first : Promise.resolve(next)));
  const view = render(<AgentSkills resetKey="agent-1:computer-1:codex" onLoad={load} />);

  view.rerender(<AgentSkills resetKey="agent-2:computer-2:pi" onLoad={load} />);
  await waitFor(() => expect(document.body.textContent).toContain("Current skill"));
  resolveFirst(ready);
  await waitFor(() =>
    expect(within(document.body).queryByRole("cell", { name: "Review" })).toBeNull(),
  );
});

test("shows unavailable state and retries", async () => {
  const load = mock(async () => ({ status: "offline" as const }));
  render(<AgentSkills resetKey="agent-1:computer-1:codex" onLoad={load} />);
  await waitFor(() =>
    expect(within(document.body).getByRole("status").textContent).toContain("offline"),
  );
  await userEvent.click(within(document.body).getByRole("button", { name: "Refresh skills" }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});

test.each(["unsupported", "error", "partial"] as const)(
  "does not present %s as an empty successful scan",
  async (status) => {
    render(
      <AgentSkills
        resetKey="scope"
        onLoad={async () => ({
          ...ready,
          result: { ...ready.result, global: { status, entries: [], directories: [] } },
        })}
      />,
    );
    await waitFor(() =>
      expect(within(document.body).getByRole("heading", { name: "Global Skills" })).toBeTruthy(),
    );
    expect(
      within(document.body).getByRole("region", { name: "Global Skills" }).textContent,
    ).not.toContain("No skills were found");
  },
);
