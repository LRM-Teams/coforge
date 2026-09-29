import { expect, test } from "bun:test";
import type { AgentMessageRequest } from "@lrm/coforge-sdk/internal";
import type { AgentSendReconciliationResponse } from "@lrm/coforge-sdk/agent";
import type {
  AgentMessageTransportResponse,
  AgentSendReconciliationRequest,
} from "#src/connection/agent-http-clients";
import { AgentExplainedRefusalError } from "#src/connection/agent-explained-refusal-error";
import { AgentTransportError } from "#src/connection/agent-transport-error";
import {
  settleAgentSend,
  type AgentSendSettlementPorts,
} from "#src/daemon-runtime/agent-send-settlement";
import { AgentSendVerdictError } from "#src/daemon-runtime/agent-send-verdict";

const send: AgentMessageRequest = {
  idempotencyKey: "key-1",
  agentId: "agent-a",
  workspaceId: "workspace-a",
  operation: "send",
  target: "@ada",
  content: "reply",
};

const sent = (messageId = "sent-1"): AgentMessageTransportResponse => ({
  idempotencyKey: "key-1",
  accepted: true,
  attentionCount: 0,
  messageId,
  messages: [],
  state: "sent",
  decision: "forward",
});

const lostBeforeResponse = () =>
  AgentTransportError.preResponseTransport("agent send", new Error("socket closed"));

/** Ports whose calls are recorded; each answer comes from the given scripts, in order. */
function ports(script: {
  sends: Array<() => Promise<AgentMessageTransportResponse>>;
  reconcile?: () => Promise<AgentSendReconciliationResponse>;
  /** Whether the target's draft holds the key; an `Error` is what the port throws instead. */
  draftHoldsKey?: boolean | Error;
}) {
  const calls: Array<{ port: "send" | "reconcile"; request: unknown }> = [];
  const heldKeys: Array<[string, string]> = [];
  const value: AgentSendSettlementPorts = {
    send: (request) => {
      calls.push({ port: "send", request });
      const next = script.sends.shift();
      if (!next) throw new Error("unexpected send");
      return next();
    },
    reconcile: (request: AgentSendReconciliationRequest) => {
      calls.push({ port: "reconcile", request });
      if (!script.reconcile) throw new Error("unexpected reconcile");
      return script.reconcile();
    },
    draftHoldsKey: async (target, idempotencyKey) => {
      heldKeys.push([target, idempotencyKey]);
      if (script.draftHoldsKey instanceof Error) throw script.draftHoldsKey;
      return script.draftHoldsKey ?? true;
    },
  };
  return { value, calls, heldKeys };
}

const settle = (
  settlement: ReturnType<typeof ports>,
  reviewerIsolation = false,
): Promise<AgentMessageTransportResponse> =>
  settleAgentSend(send, settlement.value, { reviewerIsolation, logScope: {} });

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

test("an answered send is returned as it is, with no reconciliation", async () => {
  const settlement = ports({ sends: [async () => sent()] });
  expect(await settle(settlement)).toEqual(sent());
  expect(settlement.calls.map(({ port }) => port)).toEqual(["send"]);
});

test("a send lost before any response is reconciled by its key; a commit is its success", async () => {
  const settlement = ports({
    sends: [
      async () => {
        throw lostBeforeResponse();
      },
    ],
    reconcile: async () => ({
      idempotencyKey: "key-1",
      state: "committed",
      reconciliation: true,
      receiptComplete: false,
      messageId: "committed-1",
    }),
  });

  expect(await settle(settlement)).toEqual({
    idempotencyKey: "key-1",
    accepted: true,
    attentionCount: 0,
    messageId: "committed-1",
    messages: [],
    state: "committed",
  });
  expect(settlement.calls).toEqual([
    { port: "send", request: send },
    {
      port: "reconcile",
      request: {
        idempotencyKey: "key-1",
        agentId: "agent-a",
        workspaceId: "workspace-a",
        target: "@ada",
      },
    },
  ]);
});

test("a 5xx is reconciled too, and not_found replays the original send once under its key", async () => {
  const settlement = ports({
    sends: [
      async () => {
        throw AgentTransportError.upstreamHttpResponse("server agent request", 503);
      },
      async () => sent("replayed-1"),
    ],
    reconcile: async () => ({ idempotencyKey: "key-1", state: "not_found", reconciliation: true }),
  });

  expect(await settle(settlement)).toMatchObject({ state: "sent", messageId: "replayed-1" });
  expect(settlement.calls.map(({ port, request }) => [port, request === send])).toEqual([
    ["send", true],
    ["reconcile", false],
    ["send", true],
  ]);
});

test("any 5xx is reconciled, even one whose body could not be read", async () => {
  const settlement = ports({
    sends: [
      async () => {
        throw AgentTransportError.midResponseTransport("agent send", 502, new Error("reset"));
      },
    ],
    reconcile: async () => ({
      idempotencyKey: "key-1",
      state: "committed",
      reconciliation: true,
      receiptComplete: false,
      messageId: "committed-1",
    }),
  });

  expect(await settle(settlement)).toMatchObject({ state: "committed" });
  expect(settlement.calls.map(({ port }) => port)).toEqual(["send", "reconcile"]);
});

test("a failed replay while the draft holds the key is retryable with the exact command", async () => {
  const replayFailure = lostBeforeResponse();
  const settlement = ports({
    sends: [
      async () => {
        throw lostBeforeResponse();
      },
      async () => {
        throw replayFailure;
      },
    ],
    reconcile: async () => ({ idempotencyKey: "key-1", state: "not_found", reconciliation: true }),
    draftHoldsKey: true,
  });

  const error = await failure(settle(settlement));

  expect(error).toBeInstanceOf(AgentSendVerdictError);
  const verdict = error as AgentSendVerdictError;
  expect(verdict.cause).toBe(replayFailure);
  expect(verdict.verdict).toMatchObject({ retryable: true, draftSaved: true });
  expect(verdict.verdict.suggestedNextAction).toContain(
    'coforge message send --send-draft --expected-draft-key "key-1" --target "@ada"',
  );
  expect(verdict.verdict.suggestedNextAction).toContain("cannot create a second message");
  expect(settlement.heldKeys).toEqual([["@ada", "key-1"]]);
});

test("in reviewer isolation the retry command keeps --reviewer-isolation", async () => {
  const settlement = ports({
    sends: [
      async () => {
        throw lostBeforeResponse();
      },
      async () => {
        throw lostBeforeResponse();
      },
    ],
    reconcile: async () => ({ idempotencyKey: "key-1", state: "not_found", reconciliation: true }),
  });

  const error = (await failure(settle(settlement, true))) as AgentSendVerdictError;

  expect(error.verdict.suggestedNextAction).toContain(
    'coforge message send --reviewer-isolation --send-draft --expected-draft-key "key-1" --target "@ada"',
  );
});

test("a failed replay whose draft another send took over cannot be confirmed and is not retryable", async () => {
  const settlement = ports({
    sends: [
      async () => {
        throw lostBeforeResponse();
      },
      async () => {
        throw lostBeforeResponse();
      },
    ],
    reconcile: async () => ({ idempotencyKey: "key-1", state: "not_found", reconciliation: true }),
    draftHoldsKey: false,
  });

  const error = (await failure(settle(settlement))) as AgentSendVerdictError;

  expect(error.verdict).toMatchObject({ retryable: false, draftSaved: false });
  expect(error.verdict.suggestedNextAction).toContain("CANNOT_CONFIRM");
  expect(error.verdict.suggestedNextAction).toContain("do not resend");
});

test("when reconciliation itself fails, the original failure stands", async () => {
  const original = lostBeforeResponse();
  const settlement = ports({
    sends: [
      async () => {
        throw original;
      },
    ],
    reconcile: async () => {
      throw AgentTransportError.upstreamHttpResponse("server agent request", 409);
    },
  });

  expect(await failure(settle(settlement))).toBe(original);
  expect(settlement.calls.map(({ port }) => port)).toEqual(["send", "reconcile"]);
});

test("a failure after the response started, or a refusal, is never reconciled", async () => {
  for (const refusal of [
    AgentTransportError.midResponseTransport("agent send", 200, new Error("stream reset")),
    AgentTransportError.upstreamHttpResponse("server agent request", 403),
    new Error("daemon connection is not connected"),
  ]) {
    const settlement = ports({
      sends: [
        async () => {
          throw refusal;
        },
      ],
    });
    expect(await failure(settle(settlement))).toBe(refusal);
    expect(settlement.calls.map(({ port }) => port)).toEqual(["send"]);
  }
});

const stillProcessing = () =>
  AgentExplainedRefusalError.fromResponse(
    409,
    JSON.stringify({
      error: "message request is already processing; retry later",
      code: "MESSAGE_REQUEST_IN_PROGRESS",
      retryable: true,
    }),
  )!;

test("a send whose key is still being processed names the draft's key to resend it under", async () => {
  const settlement = ports({ sends: [async () => Promise.reject(stillProcessing())] });

  const error = await failure(settle(settlement));

  expect(error).toBeInstanceOf(AgentSendVerdictError);
  const verdict = (error as AgentSendVerdictError).verdict;
  expect(verdict).toMatchObject({ retryable: true, draftSaved: true });
  expect(verdict.suggestedNextAction).toContain("may still be delivered");
  expect(verdict.suggestedNextAction).toContain(
    'coforge message send --send-draft --expected-draft-key "key-1" --target "@ada"',
  );
  expect((error as AgentSendVerdictError).cause).toBeInstanceOf(AgentExplainedRefusalError);
  expect(settlement.calls.map(({ port }) => port)).toEqual(["send"]);
  expect(settlement.heldKeys).toEqual([["@ada", "key-1"]]);
});

test("a send whose key is still being processed, its draft replaced by another send, cannot be retried", async () => {
  const settlement = ports({
    sends: [async () => Promise.reject(stillProcessing())],
    draftHoldsKey: false,
  });

  const error = await failure(settle(settlement));

  expect(error).toBeInstanceOf(AgentSendVerdictError);
  const verdict = (error as AgentSendVerdictError).verdict;
  expect(verdict).toMatchObject({ retryable: false, draftSaved: false });
  expect(verdict.suggestedNextAction).toContain("may still be delivered");
  expect(verdict.suggestedNextAction).toContain("CANNOT_CONFIRM");
  expect(verdict.suggestedNextAction).toContain("do not resend");
  expect(verdict.suggestedNextAction).toContain('coforge message read --target "@ada"');
  // The advice the draft can no longer honor is not offered.
  expect(verdict.suggestedNextAction).not.toContain("--send-draft");
  expect(verdict.suggestedNextAction).not.toContain("--expected-draft-key");
  expect((error as AgentSendVerdictError).cause).toBeInstanceOf(AgentExplainedRefusalError);
  expect(settlement.calls.map(({ port }) => port)).toEqual(["send"]);
  expect(settlement.heldKeys).toEqual([["@ada", "key-1"]]);
});

test("a draft check that fails is answered as a draft that does not hold the key", async () => {
  const settlement = ports({
    sends: [async () => Promise.reject(stillProcessing())],
    draftHoldsKey: new Error("draft store unreadable"),
  });

  const error = await failure(settle(settlement));

  expect(error).toBeInstanceOf(AgentSendVerdictError);
  const verdict = (error as AgentSendVerdictError).verdict;
  expect(verdict).toMatchObject({ retryable: false, draftSaved: false });
  expect(verdict.suggestedNextAction).toContain("CANNOT_CONFIRM");
  expect(verdict.suggestedNextAction).not.toContain("--send-draft");
  expect((error as AgentSendVerdictError).cause).toBeInstanceOf(AgentExplainedRefusalError);
  expect(settlement.heldKeys).toEqual([["@ada", "key-1"]]);
});

test("under reviewer isolation the resend command keeps the flag", async () => {
  const settlement = ports({ sends: [async () => Promise.reject(stillProcessing())] });

  const error = (await failure(settle(settlement, true))) as AgentSendVerdictError;

  expect(error.verdict.suggestedNextAction).toContain(
    "coforge message send --reviewer-isolation --send-draft --expected-draft-key",
  );
});

test("any other refusal is reported as it is", async () => {
  const refused = AgentExplainedRefusalError.fromResponse(
    403,
    JSON.stringify({ error: "left", code: "DM_PEER_NOT_IN_WORKSPACE", retryable: false }),
  )!;
  const settlement = ports({ sends: [async () => Promise.reject(refused)] });

  expect(await failure(settle(settlement))).toBe(refused);
});
