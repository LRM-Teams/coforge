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
      password: "hunter2",
    }),
  ).toMatchObject({
    detailKind: "tool_started",
    detail: "vendor__Mystery",
    entries: [{ kind: "tool_start", toolName: "vendor__Mystery" }],
  });
  // A recognized tool missing its allowlisted field falls back to the
  // canonical tool name (never the raw provider name or any other argument).
  expect(toolActivity("apply_patch", { input: "*** private patch body ***" })).toMatchObject({
    detailKind: "tool_started",
    detail: "edit_file",
    entries: [{ kind: "tool_start", toolName: "edit_file" }],
  });
});

test("new Raft-verified aliases resolve to their canonical tool and allowlisted summary", () => {
  for (const name of ["Glob", "glob", "search_files"])
    expect(toolActivity(name, { pattern: "**/*.ts", secret: "no" })).toMatchObject({
      detailKind: "tool_started",
      detail: "**/*.ts",
      entries: [{ kind: "tool_start", toolName: "glob" }],
    });
  for (const name of ["Grep", "grep"])
    expect(toolActivity(name, { query: "TODO" })).toMatchObject({
      detailKind: "tool_started",
      detail: "TODO",
      entries: [{ kind: "tool_start", toolName: "grep" }],
    });
  for (const name of ["WebFetch", "web_fetch", "fetch_url", "FetchURL"])
    expect(
      toolActivity(name, { url: "https://example.com/doc", headers: { Authorization: "secret" } }),
    ).toMatchObject({
      detailKind: "tool_started",
      detail: "https://example.com/doc",
      entries: [{ kind: "tool_start", toolName: "web_fetch" }],
    });
  for (const name of ["WebSearch", "web_search"])
    expect(toolActivity(name, { query: "coforge activity redaction" })).toMatchObject({
      detailKind: "tool_started",
      detail: "coforge activity redaction",
      entries: [{ kind: "tool_start", toolName: "web_search" }],
    });
  for (const name of ["TodoWrite", "todo_write"])
    expect(toolActivity(name, { todos: [{ content: "private plan" }] })).toMatchObject({
      detailKind: "tool_started",
      detail: "todo_write",
      entries: [{ kind: "tool_start", toolName: "todo_write" }],
    });
});

test("file_path, pattern and url summaries are truncated and never fall back to the wrong field", () => {
  expect(toolActivity("read_file", { file_path: "a".repeat(250) })).toMatchObject({
    detail: "a".repeat(200),
  });
  expect(toolActivity("grep", { pattern: "p".repeat(150) })).toMatchObject({
    detail: "p".repeat(120),
  });
  expect(toolActivity("web_fetch", { url: "https://" + "x".repeat(250) })).toMatchObject({
    detail: ("https://" + "x".repeat(250)).slice(0, 200),
  });
  // Non-string values never leak into the detail.
  expect(toolActivity("read_file", { file_path: { nested: "value" } })).toMatchObject({
    detail: "read_file",
  });
});

test("non-CoForge bash commands are redacted, truncated to 100 Unicode characters and cut at heredocs", () => {
  const secretCommand =
    'curl -H "Authorization: Bearer sk-liveTESTsecretTOKEN123" --data "password=hunter2" https://example.com';
  const result = toolActivity("bash", { command: secretCommand });
  expect(result.detailKind).toBe("running_command");
  expect(result.detail).not.toContain("sk-liveTESTsecretTOKEN123");
  expect(result.detail).not.toContain("hunter2");
  expect(result.detail).toContain("Bearer [REDACTED]");
  expect(result.detail).toContain("password=[REDACTED]");
  expect(result.entries).toEqual([{ kind: "tool_start", toolName: "bash" }]);

  const long = "echo " + "a".repeat(200);
  const truncated = toolActivity("bash", { command: long });
  expect([...truncated.detail].length).toBe(100);
  expect(truncated.detail).toBe(long.slice(0, 100));

  const heredocCommand = `cat <<'EOF'\nprivate body with password=hunter2\nEOF`;
  const heredocResult = toolActivity("bash", { command: heredocCommand });
  expect(heredocResult.detail).not.toContain("private body");
  expect(heredocResult.detail).not.toContain("hunter2");
  expect(JSON.stringify(heredocResult)).not.toContain("private body");
});

test("CoForge CLI invocations resolve to a semantic tool and allowlisted summary, never the raw command", () => {
  const cases: {
    command: string;
    detailKind: string;
    toolName: string;
    detail: string;
  }[] = [
    {
      command: "coforge message check",
      detailKind: "checking_messages",
      toolName: "check_messages",
      detail: "check_messages",
    },
    {
      command: "coforge message read --target @alice --limit 20",
      detailKind: "tool_started",
      toolName: "read_history",
      detail: "@alice",
    },
    {
      command: "coforge message search --query hello --target #general",
      detailKind: "tool_started",
      toolName: "search_messages",
      detail: "hello",
    },
    {
      command: "coforge message resolve deadbeef",
      detailKind: "tool_started",
      toolName: "resolve_message",
      detail: "resolve_message",
    },
    {
      command: "coforge message react --message-id deadbeef --emoji :+1:",
      detailKind: "tool_started",
      toolName: "react_message",
      detail: "react_message",
    },
    {
      command: "coforge inbox check",
      detailKind: "checking_messages",
      toolName: "check_inbox",
      detail: "check_inbox",
    },
    {
      command: "coforge channel mute --target '#general'",
      detailKind: "tool_started",
      toolName: "mute_channel",
      detail: "#general",
    },
    {
      command: "coforge channel unmute --target '#general'",
      detailKind: "tool_started",
      toolName: "unmute_channel",
      detail: "#general",
    },
    {
      command: "coforge thread unfollow --target '#general:deadbeef'",
      detailKind: "tool_started",
      toolName: "unfollow_thread",
      detail: "#general:deadbeef",
    },
    {
      command: "coforge task list --target #general",
      detailKind: "tool_started",
      toolName: "list_tasks",
      detail: "#general",
    },
    {
      command: "coforge task create --target #general --title 'Ship the thing'",
      detailKind: "tool_started",
      toolName: "create_task",
      detail: "#general",
    },
    {
      command: "coforge task convert --target #general --message-id deadbeef",
      detailKind: "tool_started",
      toolName: "convert_task",
      detail: "#general",
    },
    {
      command: "coforge task claim --target #general --number 7",
      detailKind: "tool_started",
      toolName: "claim_tasks",
      detail: "#general #7",
    },
    {
      command: "coforge task unclaim --target #general --number 7",
      detailKind: "tool_started",
      toolName: "unclaim_task",
      detail: "#general #7",
    },
    {
      command: "coforge task assign --target #general --number 7 --assignee @bob",
      detailKind: "tool_started",
      toolName: "assign_task",
      detail: "#general #7",
    },
    {
      command: "coforge task update --target #general --number 7 --status done",
      detailKind: "tool_started",
      toolName: "update_task_status",
      detail: "#general #7",
    },
    {
      command: "coforge task amend --target #general --number 7 --title 'New title'",
      detailKind: "tool_started",
      toolName: "amend_task",
      detail: "#general #7",
    },
    {
      command: "coforge task history --target #general --number 7",
      detailKind: "tool_started",
      toolName: "task_history",
      detail: "#general #7",
    },
    {
      command: "coforge task delete --target #general --number 7",
      detailKind: "tool_started",
      toolName: "delete_task",
      detail: "#general #7",
    },
    {
      command: "coforge task receipt --target #general --number 7",
      detailKind: "tool_started",
      toolName: "task_receipt",
      detail: "#general #7",
    },
    {
      command: "coforge attachment view --id deadbeef --output /tmp/out.png",
      detailKind: "tool_started",
      toolName: "view_file",
      detail: "view_file",
    },
    {
      command:
        "coforge reminder schedule --title 'Follow up with finance' --target @bob --message-id deadbeef --delay-seconds 60",
      detailKind: "tool_started",
      toolName: "schedule_reminder",
      detail: "Follow up with finance",
    },
    {
      command: "coforge reminder list --all",
      detailKind: "tool_started",
      toolName: "list_reminders",
      detail: "list_reminders",
    },
    {
      command: "coforge reminder update --id deadbeef-dead-beef-dead-beefdeadbeef --title 'New'",
      detailKind: "tool_started",
      toolName: "update_reminder",
      detail: "deadbeef",
    },
    {
      command:
        "coforge reminder snooze --id deadbeef-dead-beef-dead-beefdeadbeef --delay-seconds 60",
      detailKind: "tool_started",
      toolName: "snooze_reminder",
      detail: "deadbeef",
    },
    {
      command: "coforge reminder cancel --id deadbeef-dead-beef-dead-beefdeadbeef",
      detailKind: "tool_started",
      toolName: "cancel_reminder",
      detail: "deadbeef",
    },
    {
      command: "coforge reminder log --id deadbeef-dead-beef-dead-beefdeadbeef",
      detailKind: "tool_started",
      toolName: "reminder_log",
      detail: "deadbeef",
    },
    {
      command: "coforge reminder ack --id deadbeef-dead-beef-dead-beefdeadbeef --revision 3",
      detailKind: "tool_started",
      toolName: "ack_reminder",
      detail: "deadbeef",
    },
    {
      command: "coforge reminder dismiss --id deadbeef-dead-beef-dead-beefdeadbeef --revision 3",
      detailKind: "tool_started",
      toolName: "dismiss_reminder",
      detail: "deadbeef",
    },
    {
      command: "coforge weekly-report context --subject-type report --subject-id deadbeef",
      detailKind: "tool_started",
      toolName: "weekly_report",
      detail: "weekly_report",
    },
    {
      command: "coforge workspace info --agents",
      detailKind: "tool_started",
      toolName: "coforge_cli",
      detail: "coforge_cli",
    },
    {
      command:
        "coforge manual get index --intent 'Learn available CoForge workflows' --reason 'Browse the topic catalog'",
      detailKind: "tool_started",
      toolName: "get_manual",
      detail: "index",
    },
    {
      command:
        "coforge manual search 'github pull request' --intent 'Open a PR' --reason 'Find the right command'",
      detailKind: "tool_started",
      toolName: "search_manual",
      detail: "github pull request",
    },
    {
      command: "/usr/local/bin/coforge message check",
      detailKind: "checking_messages",
      toolName: "check_messages",
      detail: "check_messages",
    },
    {
      command: "coforge whoami --json",
      detailKind: "tool_started",
      toolName: "whoami",
      detail: "whoami",
    },
    {
      command: "coforge version --json",
      detailKind: "tool_started",
      toolName: "get_version",
      detail: "get_version",
    },
  ];
  for (const { command, detailKind, toolName, detail } of cases) {
    expect(toolActivity("bash", { command })).toMatchObject({
      detailKind,
      detail,
      entries: [{ kind: "tool_start", toolName }],
    });
  }
});

test("the CoForge message send heredoc form never leaks the message body", () => {
  const command = [
    "coforge message send --target @bob <<'COFORGE_MESSAGE'",
    "Here is the deploy password: hunter2 and the API key: sk-liveTESTsecret",
    "COFORGE_MESSAGE",
  ].join("\n");
  const result = toolActivity("bash", { command });
  expect(result).toMatchObject({
    detailKind: "tool_started",
    detail: "@bob",
    entries: [{ kind: "tool_start", toolName: "send_message" }],
  });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("hunter2");
  expect(serialized).not.toContain("sk-liveTESTsecret");
  expect(serialized).not.toContain("Here is the deploy password");
});

test("CoForge CLI tokenising respects quotes and backslashes", () => {
  expect(
    toolActivity("bash", { command: "coforge channel mute --target '#has spaces'" }),
  ).toMatchObject({ detail: "#has spaces" });
  expect(
    toolActivity("bash", {
      command: 'coforge message search --query "say \\"hi\\" now" --target #general',
    }),
  ).toMatchObject({ detail: 'say "hi" now' });
  expect(
    toolActivity("bash", { command: "coforge channel mute --target \\#escaped-space" }),
  ).toMatchObject({ detail: "#escaped-space" });
});

test("CoForge CLI tokenising stops at pipes, chains and semicolons before mapping the subcommand", () => {
  const piped = toolActivity("bash", { command: "coforge message check | grep unread" });
  expect(piped).toMatchObject({ detailKind: "checking_messages" });
  expect(piped.entries).toEqual([{ kind: "tool_start", toolName: "check_messages" }]);
  expect(toolActivity("bash", { command: "coforge inbox check && echo done" }).entries).toEqual([
    { kind: "tool_start", toolName: "check_inbox" },
  ]);
  expect(toolActivity("bash", { command: "coforge message check; echo done" }).entries).toEqual([
    { kind: "tool_start", toolName: "check_messages" },
  ]);
});

test("a bare `coforge` with no subcommand and a non-coforge shell command are unaffected", () => {
  expect(toolActivity("bash", { command: "coforge" })).toMatchObject({
    detailKind: "running_command",
    detail: "coforge",
    entries: [{ kind: "tool_start", toolName: "bash" }],
  });
  expect(toolActivity("bash", { command: "bun test packages/daemon" })).toMatchObject({
    detailKind: "running_command",
    detail: "bun test packages/daemon",
    entries: [{ kind: "tool_start", toolName: "bash" }],
  });
});
