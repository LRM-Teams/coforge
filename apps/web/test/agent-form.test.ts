import { expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import {
  agentEnvironmentNameError,
  agentUpdateErrorMessage,
  agentEnvironmentRowsChanged,
  parseAgentEnvironmentFromForm,
} from "#src/features/agents/agent-form";
import { m } from "#src/paraglide/messages";

function formWithEnvRows(rows: { key: string; value: string }[]) {
  const form = new FormData();
  for (const row of rows) {
    form.append("envKey", row.key);
    form.append("envValue", row.value);
  }
  return form;
}

test("parseAgentEnvironmentFromForm drops empty keys and keeps the last duplicate", () => {
  const form = formWithEnvRows([
    { key: "FOO", value: "one" },
    { key: "", value: "ignored" },
    { key: "  ", value: "ignored" },
    { key: "FOO", value: "two" },
    { key: "BAR", value: "bar" },
  ]);
  expect(parseAgentEnvironmentFromForm(form)).toEqual({ FOO: "two", BAR: "bar" });
});

test("parseAgentEnvironmentFromForm trims keys but leaves values untouched", () => {
  const form = formWithEnvRows([{ key: "  SPACED  ", value: "  padded  " }]);
  expect(parseAgentEnvironmentFromForm(form)).toEqual({ SPACED: "  padded  " });
});

test("parseAgentEnvironmentFromForm returns an empty map for a form with no env rows", () => {
  expect(parseAgentEnvironmentFromForm(new FormData())).toEqual({});
});

test("agentEnvironmentRowsChanged is order-insensitive and ignores blank-key rows", () => {
  const initial = { A: "1", B: "2" };
  expect(
    agentEnvironmentRowsChanged(
      [
        { key: "B", value: "2" },
        { key: "A", value: "1" },
      ],
      initial,
    ),
  ).toBe(false);
  expect(
    agentEnvironmentRowsChanged(
      [
        { key: "A", value: "1" },
        { key: "B", value: "2" },
        { key: "", value: "should not count" },
      ],
      initial,
    ),
  ).toBe(false);
});

test("agentEnvironmentRowsChanged reports true for an added, removed, or changed row", () => {
  const initial = { A: "1" };
  expect(
    agentEnvironmentRowsChanged(
      [
        { key: "A", value: "1" },
        { key: "B", value: "2" },
      ],
      initial,
    ),
  ).toBe(true);
  expect(agentEnvironmentRowsChanged([], initial)).toBe(true);
  expect(agentEnvironmentRowsChanged([{ key: "A", value: "different" }], initial)).toBe(true);
});

test("agentEnvironmentNameError flags a name the server would refuse, before Save sends it", () => {
  const invalidName = m.agent_env_invalid_name({ max: 128 });
  expect(agentEnvironmentNameError("11")).toBe(invalidName);
  expect(agentEnvironmentNameError("BAD-NAME")).toBe(invalidName);
  expect(agentEnvironmentNameError("A".repeat(129))).toBe(invalidName);
  expect(agentEnvironmentNameError("path")).toBe(m.agent_env_reserved_name());
  expect(agentEnvironmentNameError("COFORGE_TOKEN")).toBe(m.agent_env_reserved_name());
  expect(agentEnvironmentNameError(" MY_VAR ")).toBeUndefined();
  expect(agentEnvironmentNameError("_x1")).toBeUndefined();
  // A blank row is dropped on save (`parseAgentEnvironmentFromForm`), so it is not an error.
  expect(agentEnvironmentNameError("  ")).toBeUndefined();
});

test("a refused environment save shows the broken rule instead of asking to try again", () => {
  const refusal = (errorId: string) =>
    agentUpdateErrorMessage(new AppError("INVALID_INPUT", { errorId }));
  expect(refusal("agent-environment-invalid-name")).toBe(m.agent_env_invalid_name({ max: 128 }));
  expect(refusal("agent-environment-reserved-name")).toBe(m.agent_env_reserved_name());
  expect(refusal("agent-environment-invalid-value")).toBe(m.agent_env_invalid_value());
  expect(refusal("agent-environment-too-many")).toBe(m.agent_env_too_many({ max: 64 }));
  expect(refusal("agent-environment-too-large")).toBe(m.agent_env_too_large());
});
