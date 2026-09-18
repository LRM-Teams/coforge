import { expect, test } from "bun:test";
import { TOOL_ALIASES, TOOL_LABELS, canonicalToolName, toolActivityLabel } from "./tool-display";

test("a known canonical tool resolves through its aliases to the same label", () => {
  for (const name of ["read", "Read", "ReadFile", "file_read", "read_file"])
    expect(toolActivityLabel(name)).toBe("Reading file…");
  expect(toolActivityLabel("bash")).toBe("Running command…");
  expect(toolActivityLabel("Shell")).toBe("Running command…");
  expect(TOOL_LABELS.check_inbox).toBe("Checking inbox");
  expect(toolActivityLabel("check_inbox")).toBe("Checking inbox…");
});

test("an unrecognized tool falls back to a generic, name-based label", () => {
  expect(toolActivityLabel("vendor__Mystery")).toBe("Using vendor__Mystery…");
});

test("an unrecognized tool's name is capped at 20 characters, with the double ellipsis this leaves", () => {
  const name = "a_very_long_unrecognized_tool_name";
  expect(toolActivityLabel(name)).toBe(`Using ${name.slice(0, 20)}……`);
});

test("an MCP-style prefix is stripped before resolving the canonical name", () => {
  expect(toolActivityLabel("mcp__custom__inspect")).toBe("Using inspect…");
  expect(toolActivityLabel("mcp_chat_bash")).toBe("Running command…");
  expect(canonicalToolName("mcp__custom__inspect")).toEqual({
    canonical: "inspect",
    name: "inspect",
  });
});

test("every TOOL_ALIASES value is itself a key, so a canonical name is its own identity mapping", () => {
  for (const canonical of new Set(Object.values(TOOL_ALIASES)))
    expect(TOOL_ALIASES[canonical]).toBe(canonical);
});
