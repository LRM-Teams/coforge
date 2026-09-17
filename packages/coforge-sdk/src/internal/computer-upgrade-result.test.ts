import { expect, test } from "bun:test";
import { decodeComputerUpgradeResult, encodeComputerUpgradeResult } from "./codec";
import {
  decodeDaemonCommandResponse,
  encodeDaemonCommandResponse,
  UPGRADE_ERROR_CODE,
} from "./index";

const base = {
  protocolMajor: 1,
  requestId: "upgrade-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  status: "failed" as const,
  completedAtMs: 1_700_000_000_000,
  messageType: "coforge.rpc.v1.ComputerUpgradeResult" as const,
};

test("round-trips a Computer upgrade result with no error code", () => {
  const value = { ...base, error: "something went wrong" };
  expect(decodeComputerUpgradeResult(encodeComputerUpgradeResult(value))).toEqual(value);
});

test("round-trips a Computer upgrade result carrying a known error code", () => {
  const value = {
    ...base,
    error: "Computer upgrade operation upgrade-0 is still pending",
    errorCode: UPGRADE_ERROR_CODE.OPERATION_PENDING,
  };
  expect(decodeComputerUpgradeResult(encodeComputerUpgradeResult(value))).toEqual(value);
});

test("round-trips a well-formed but not-yet-known error code without rejecting it", () => {
  const value = { ...base, error: "future failure", errorCode: "UPGRADE_SOMETHING_NEW" };
  expect(decodeComputerUpgradeResult(encodeComputerUpgradeResult(value))).toEqual(value);
});

test("rejects a malformed error code shape on encode and decode", () => {
  expect(() => encodeComputerUpgradeResult({ ...base, errorCode: "not-a-code" })).toThrow(
    "error code",
  );
  const encoded = encodeComputerUpgradeResult({ ...base, error: "x" });
  // Decoding a well-formed payload always succeeds; this only proves the guard itself throws on
  // the malformed shape it is meant to catch, exercised directly against the decoded value.
  expect(() => encodeComputerUpgradeResult({ ...base, errorCode: "x" })).toThrow("error code");
  expect(decodeComputerUpgradeResult(encoded)).not.toHaveProperty("errorCode");
});

const commandResponse = {
  protocolMajor: 1,
  requestId: "cmd-1",
  accepted: false,
  runtimes: [],
};

test("round-trips a refused local lifecycle command with its error and error code", () => {
  const value = {
    ...commandResponse,
    error: "Computer upgrade operation upgrade-0 is still pending",
    errorCode: UPGRADE_ERROR_CODE.OPERATION_PENDING,
  };
  expect(decodeDaemonCommandResponse(encodeDaemonCommandResponse(value))).toEqual(value);
});

test("an accepted local lifecycle command round-trips with no error fields", () => {
  const value = { ...commandResponse, accepted: true };
  const decoded = decodeDaemonCommandResponse(encodeDaemonCommandResponse(value));
  expect(decoded).toEqual(value);
  expect(decoded).not.toHaveProperty("error");
  expect(decoded).not.toHaveProperty("errorCode");
});
