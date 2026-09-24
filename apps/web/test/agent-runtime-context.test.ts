import { expect, test } from "bun:test";
import { buildAgentRuntimeContext } from "#src/server/agents/agent-runtime-context.server";

test("buildAgentRuntimeContext maps every known Workspace/Computer field", () => {
  expect(
    buildAgentRuntimeContext({
      workspaceId: "workspace-1",
      workspace: { slug: "acme", name: "Acme" },
      computerId: "computer-1",
      computer: {
        name: "workstation-7",
        displayName: "Builder Box",
        platform: "darwin",
        osVersion: "15.6",
        computerVersion: "0.1.0-dev.40",
      },
    }),
  ).toEqual({
    workspaceId: "workspace-1",
    workspaceSlug: "acme",
    workspaceName: "Acme",
    computerId: "computer-1",
    computerName: "Builder Box",
    computerOs: "darwin 15.6",
    computerVersion: "0.1.0-dev.40",
    computerHostname: "workstation-7",
  });
});

test("buildAgentRuntimeContext falls back to the OS hostname when displayName is blank", () => {
  expect(
    buildAgentRuntimeContext({
      workspaceId: "workspace-1",
      workspace: { slug: "acme", name: "Acme" },
      computerId: "computer-1",
      computer: {
        name: "workstation-7",
        displayName: "  ",
        platform: null,
        osVersion: null,
        computerVersion: null,
      },
    }),
  ).toEqual({
    workspaceId: "workspace-1",
    workspaceSlug: "acme",
    workspaceName: "Acme",
    computerId: "computer-1",
    computerName: "workstation-7",
    computerHostname: "workstation-7",
  });
});

test("buildAgentRuntimeContext omits every Computer field when there is no Computer", () => {
  expect(
    buildAgentRuntimeContext({
      workspaceId: "workspace-1",
      workspace: { slug: "acme", name: "Acme" },
      computerId: null,
      computer: null,
    }),
  ).toEqual({
    workspaceId: "workspace-1",
    workspaceSlug: "acme",
    workspaceName: "Acme",
  });
});

test("buildAgentRuntimeContext omits every field when nothing is known", () => {
  expect(
    buildAgentRuntimeContext({
      workspaceId: "",
      workspace: null,
      computerId: null,
      computer: null,
    }),
  ).toEqual({});
});
