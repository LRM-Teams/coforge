import { expect, test } from "bun:test";
import {
  encodeDaemonRuntimeProviderModelRefreshRequest,
  decodeDaemonRuntimeProviderModelRefreshRequest,
  encodeDaemonRuntimeProviderModelRefreshResponse,
  decodeDaemonRuntimeProviderModelRefreshResponse,
} from "./codec";
import { MODEL_REFRESH_MESSAGE_TYPE, MODEL_REFRESH_RESPONSE_MESSAGE_TYPE } from "./index";

function refreshRequest() {
  return {
    protocolMajor: 1,
    requestId: "refresh-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    messageType: MODEL_REFRESH_MESSAGE_TYPE,
  };
}

test("model refresh request round-trips", () => {
  expect(
    decodeDaemonRuntimeProviderModelRefreshRequest(
      encodeDaemonRuntimeProviderModelRefreshRequest(refreshRequest()),
    ),
  ).toEqual(refreshRequest());
});

test("model refresh response round-trips with its catalog", () => {
  const message = {
    ...refreshRequest(),
    accepted: true,
    status: "refreshed",
    message: undefined,
    catalogs: [
      {
        provider: "codex" as const,
        models: [
          {
            id: "gpt-5.1-codex",
            displayName: "GPT-5.1 Codex",
            description: "",
            modelProvider: "openai",
            reasoningEfforts: ["low", "medium", "high"],
            defaultReasoning: "medium",
            recommended: true,
          },
        ],
      },
    ],
    messageType: MODEL_REFRESH_RESPONSE_MESSAGE_TYPE,
  };
  expect(
    decodeDaemonRuntimeProviderModelRefreshResponse(
      encodeDaemonRuntimeProviderModelRefreshResponse(message),
    ),
  ).toEqual(message);
});

test("model refresh response without a catalog decodes with an empty list", () => {
  const decoded = decodeDaemonRuntimeProviderModelRefreshResponse(
    encodeDaemonRuntimeProviderModelRefreshResponse({
      ...refreshRequest(),
      accepted: false,
      status: "error",
      message: "probe exploded",
    }),
  );
  expect(decoded).toMatchObject({
    accepted: false,
    status: "error",
    message: "probe exploded",
    catalogs: [],
  });
});
