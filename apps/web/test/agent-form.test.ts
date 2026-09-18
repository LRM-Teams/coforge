import { expect, test } from "bun:test";
import {
  agentEnvironmentRowsChanged,
  parseAgentEnvironmentFromForm,
} from "@/features/agents/agent-form";

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
