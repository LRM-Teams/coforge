import { expect, test } from "bun:test";
import { toolActivity } from "../src/code-agent/tool-activity";

test("provider tool aliases retain known file and command semantics without exposing content", () => {
  for (const name of ["read", "Read", "ReadFile", "file_read", "read_file"])
    expect(toolActivity(name, { path: "src/a.ts", content: "private contents" })).toMatchObject({
      detailKind: "tool_started",
      detail: "src/a.ts",
      entries: [{ kind: "tool_start", toolName: "read_file" }],
    });
  for (const name of ["write", "Write", "WriteFile", "file_write", "write_file"])
    expect(
      toolActivity(name, { file_path: "src/a.ts", content: "private contents" }),
    ).toMatchObject({
      detailKind: "tool_started",
      detail: "src/a.ts",
      entries: [{ kind: "tool_start", toolName: "write_file" }],
    });
  for (const name of [
    "edit",
    "Edit",
    "EditFile",
    "edit_file",
    "file_change",
    "StrReplaceFile",
    "apply_patch",
  ])
    expect(toolActivity(name, { path: "src/a.ts", patch: "private diff" })).toMatchObject({
      detailKind: "tool_started",
      detail: "src/a.ts",
      entries: [{ kind: "tool_start", toolName: "edit_file" }],
    });
  for (const name of [
    "bash",
    "Bash",
    "shell",
    "Shell",
    "command_execution",
    "run_shell_command",
    "run_terminal_command",
  ])
    expect(toolActivity(name, { command: "pwd" })).toMatchObject({
      detailKind: "running_command",
      detail: "pwd",
      entries: [{ kind: "tool_start", toolName: "bash" }],
    });
});

test("unrecognized tools never infer file edits from arguments or emit prompts and patches", () => {
  expect(
    toolActivity("vendor__Mystery", {
      path: "secret/path",
      command: "secret command",
      prompt: "secret prompt",
    }),
  ).toMatchObject({
    detailKind: "tool_started",
    detail: "vendor__Mystery",
    entries: [{ kind: "tool_start", toolName: "vendor__Mystery" }],
  });
  expect(toolActivity("apply_patch", { input: "*** private patch body ***" })).toMatchObject({
    detailKind: "tool_started",
    detail: "apply_patch",
    entries: [{ kind: "tool_start", toolName: "edit_file" }],
  });
});
