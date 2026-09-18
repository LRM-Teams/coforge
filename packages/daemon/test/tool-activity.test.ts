import { expect, test } from "bun:test";
import { toolActivityLabel } from "@lrm/coforge-sdk/internal";
import { toolActivity } from "../src/code-agent/tool-activity";

test("provider tool aliases retain known file and command semantics without exposing content", () => {
  for (const name of ["read", "Read", "ReadFile", "file_read", "read_file"])
    expect(toolActivity(name, { path: "src/a.ts", content: "private contents" })).toMatchObject({
      detailKind: "tool_started",
      detail: "Reading file…",
      entries: [{ kind: "tool_start", toolName: "read_file", toolInput: "src/a.ts" }],
    });
  for (const name of ["write", "Write", "WriteFile", "file_write", "write_file"])
    expect(
      toolActivity(name, { file_path: "src/a.ts", content: "private contents" }),
    ).toMatchObject({
      detailKind: "tool_started",
      detail: "Writing file…",
      entries: [{ kind: "tool_start", toolName: "write_file", toolInput: "src/a.ts" }],
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
      detail: "Editing file…",
      entries: [{ kind: "tool_start", toolName: "edit_file", toolInput: "src/a.ts" }],
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
      detail: "Running command…",
      entries: [{ kind: "tool_start", toolName: "bash", toolInput: "pwd" }],
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
    detail: "Using vendor__Mystery…",
    entries: [{ kind: "tool_start", toolName: "vendor__Mystery" }],
  });
  // A recognized tool missing its allowlisted field falls back to its generic label
  // (never the raw provider name or any other argument) and carries no toolInput.
  const missingField = toolActivity("apply_patch", { input: "*** private patch body ***" });
  expect(missingField).toMatchObject({
    detailKind: "tool_started",
    detail: "Editing file…",
    entries: [{ kind: "tool_start", toolName: "edit_file" }],
  });
  expect(missingField.entries[0]).not.toHaveProperty("toolInput");
});

test("an unrecognized tool's generic label is built from its name alone, never from arguments", () => {
  expect(toolActivity("vendor__Mystery", {})).toMatchObject({
    detail: toolActivityLabel("vendor__Mystery"),
  });
  const longName = "a_very_long_and_unrecognized_tool_identifier";
  expect(toolActivity(longName, {})).toMatchObject({ detail: toolActivityLabel(longName) });
  expect(toolActivityLabel(longName)).toBe(`Using ${longName.slice(0, 20)}……`);
});

test("new aliases resolve to their canonical tool and an allowlisted toolInput summary", () => {
  for (const name of ["Glob", "glob", "search_files"])
    expect(toolActivity(name, { pattern: "**/*.ts", secret: "no" })).toMatchObject({
      detailKind: "tool_started",
      detail: "Searching files…",
      entries: [{ kind: "tool_start", toolName: "glob", toolInput: "**/*.ts" }],
    });
  for (const name of ["Grep", "grep"])
    expect(toolActivity(name, { query: "TODO" })).toMatchObject({
      detailKind: "tool_started",
      detail: "Searching code…",
      entries: [{ kind: "tool_start", toolName: "grep", toolInput: "TODO" }],
    });
  for (const name of ["WebFetch", "web_fetch", "fetch_url", "FetchURL"])
    expect(
      toolActivity(name, { url: "https://example.com/doc", headers: { Authorization: "secret" } }),
    ).toMatchObject({
      detailKind: "tool_started",
      detail: "Fetching web…",
      entries: [
        { kind: "tool_start", toolName: "web_fetch", toolInput: "https://example.com/doc" },
      ],
    });
  for (const name of ["WebSearch", "web_search"])
    expect(toolActivity(name, { query: "coforge activity redaction" })).toMatchObject({
      detailKind: "tool_started",
      detail: "Searching web…",
      entries: [
        { kind: "tool_start", toolName: "web_search", toolInput: "coforge activity redaction" },
      ],
    });
  for (const name of ["TodoWrite", "todo_write"]) {
    const result = toolActivity(name, { todos: [{ content: "private plan" }] });
    expect(result).toMatchObject({
      detailKind: "tool_started",
      detail: "Updating tasks…",
      entries: [{ kind: "tool_start", toolName: "todo_write" }],
    });
    expect(result.entries[0]).not.toHaveProperty("toolInput");
  }
});

test("file_path, pattern and url toolInput summaries are truncated and never fall back to the wrong field", () => {
  expect(toolActivity("read_file", { file_path: "a".repeat(250) })).toMatchObject({
    entries: [{ toolInput: "a".repeat(200) }],
  });
  expect(toolActivity("grep", { pattern: "p".repeat(150) })).toMatchObject({
    entries: [{ toolInput: "p".repeat(120) }],
  });
  expect(toolActivity("web_fetch", { url: "https://" + "x".repeat(250) })).toMatchObject({
    entries: [{ toolInput: ("https://" + "x".repeat(250)).slice(0, 200) }],
  });
  // Non-string values never leak into the toolInput, and the entry carries none.
  const nested = toolActivity("read_file", { file_path: { nested: "value" } });
  expect(nested).toMatchObject({ detail: "Reading file…" });
  expect(nested.entries[0]).not.toHaveProperty("toolInput");
});

test("non-CoForge bash commands: detail is always the generic label, toolInput is redacted, truncated to 100 Unicode characters and cut at heredocs", () => {
  const secretCommand =
    'curl -H "Authorization: Bearer sk-liveTESTsecretTOKEN123" --data "password=hunter2" https://example.com';
  const result = toolActivity("bash", { command: secretCommand });
  expect(result.detailKind).toBe("running_command");
  expect(result.detail).toBe("Running command…");
  const toolInput = result.entries[0]!.toolInput!;
  expect(toolInput).not.toContain("sk-liveTESTsecretTOKEN123");
  expect(toolInput).not.toContain("hunter2");
  expect(toolInput).toContain("Bearer [REDACTED]");
  expect(toolInput).toContain("password=[REDACTED]");
  expect(JSON.stringify(result)).not.toContain("hunter2");
  expect(JSON.stringify(result)).not.toContain("sk-liveTESTsecretTOKEN123");

  const long = "echo " + "a".repeat(200);
  const truncated = toolActivity("bash", { command: long });
  expect(truncated.detail).toBe("Running command…");
  const truncatedInput = truncated.entries[0]!.toolInput!;
  expect([...truncatedInput].length).toBe(100);
  expect(truncatedInput).toBe(long.slice(0, 100));

  const heredocCommand = `cat <<'EOF'\nprivate body with password=hunter2\nEOF`;
  const heredocResult = toolActivity("bash", { command: heredocCommand });
  expect(heredocResult.detail).toBe("Running command…");
  const serialized = JSON.stringify(heredocResult);
  expect(serialized).not.toContain("private body");
  expect(serialized).not.toContain("hunter2");
});

test("a multi-line bash command with no heredoc is sanitized to a single-line toolInput", () => {
  const command = ["if [ -f a.txt ]; then", "  echo start", "  echo password=hunter2", "fi"].join(
    "\n",
  );
  const result = toolActivity("bash", { command });
  expect(result.detailKind).toBe("running_command");
  expect(result.detail).toBe("Running command…");
  const toolInput = result.entries[0]!.toolInput!;
  // No control character (including newline) reaches the wire: validToolInput
  // (packages/coforge-sdk/src/internal/activity-entries.ts) rejects one outright.
  expect(/[\x00-\x1f\x7f]/.test(toolInput)).toBe(false);
  expect(toolInput).not.toContain("\n");
  expect([...toolInput].length).toBeLessThanOrEqual(200);
  expect(toolInput).toContain("password=[REDACTED]");
  expect(toolInput).not.toContain("hunter2");
});

test("CoForge CLI invocations resolve to a semantic tool and an allowlisted toolInput summary, never the raw command", () => {
  const cases: {
    command: string;
    detailKind: string;
    toolName: string;
    toolInput?: string;
  }[] = [
    {
      command: "coforge message check",
      detailKind: "checking_messages",
      toolName: "check_messages",
    },
    {
      command: "coforge message read --target @alice --limit 20",
      detailKind: "tool_started",
      toolName: "read_history",
      toolInput: "@alice",
    },
    {
      command: "coforge message search --query hello --target #general",
      detailKind: "tool_started",
      toolName: "search_messages",
      toolInput: "hello",
    },
    {
      command: "coforge message resolve deadbeef",
      detailKind: "tool_started",
      toolName: "resolve_message",
    },
    {
      command: "coforge message react --message-id deadbeef --emoji :+1:",
      detailKind: "tool_started",
      toolName: "react_message",
    },
    { command: "coforge inbox check", detailKind: "checking_messages", toolName: "check_inbox" },
    {
      command: "coforge channel mute --target '#general'",
      detailKind: "tool_started",
      toolName: "mute_channel",
      toolInput: "#general",
    },
    {
      command: "coforge channel unmute --target '#general'",
      detailKind: "tool_started",
      toolName: "unmute_channel",
      toolInput: "#general",
    },
    {
      command: "coforge thread unfollow --target '#general:deadbeef'",
      detailKind: "tool_started",
      toolName: "unfollow_thread",
      toolInput: "#general:deadbeef",
    },
    {
      command: "coforge task list --target #general",
      detailKind: "tool_started",
      toolName: "list_tasks",
      toolInput: "#general",
    },
    {
      command: "coforge task create --target #general --title 'Ship the thing'",
      detailKind: "tool_started",
      toolName: "create_task",
      toolInput: "#general",
    },
    {
      command: "coforge task convert --target #general --message-id deadbeef",
      detailKind: "tool_started",
      toolName: "convert_task",
      toolInput: "#general",
    },
    {
      command: "coforge task claim --target #general --number 7",
      detailKind: "tool_started",
      toolName: "claim_tasks",
      toolInput: "#general #7",
    },
    {
      command: "coforge task unclaim --target #general --number 7",
      detailKind: "tool_started",
      toolName: "unclaim_task",
      toolInput: "#general #7",
    },
    {
      command: "coforge task assign --target #general --number 7 --assignee @bob",
      detailKind: "tool_started",
      toolName: "assign_task",
      toolInput: "#general #7",
    },
    {
      command: "coforge task update --target #general --number 7 --status done",
      detailKind: "tool_started",
      toolName: "update_task_status",
      toolInput: "#general #7",
    },
    {
      command: "coforge task amend --target #general --number 7 --title 'New title'",
      detailKind: "tool_started",
      toolName: "amend_task",
      toolInput: "#general #7",
    },
    {
      command: "coforge task history --target #general --number 7",
      detailKind: "tool_started",
      toolName: "task_history",
      toolInput: "#general #7",
    },
    {
      command: "coforge task delete --target #general --number 7",
      detailKind: "tool_started",
      toolName: "delete_task",
      toolInput: "#general #7",
    },
    {
      command: "coforge task receipt --target #general --number 7",
      detailKind: "tool_started",
      toolName: "task_receipt",
      toolInput: "#general #7",
    },
    {
      command: "coforge attachment view --id deadbeef --output /tmp/out.png",
      detailKind: "tool_started",
      toolName: "view_file",
    },
    {
      command:
        "coforge reminder schedule --title 'Follow up with finance' --target @bob --message-id deadbeef --delay-seconds 60",
      detailKind: "tool_started",
      toolName: "schedule_reminder",
      toolInput: "Follow up with finance",
    },
    {
      command: "coforge reminder list --all",
      detailKind: "tool_started",
      toolName: "list_reminders",
    },
    {
      command: "coforge reminder update --id deadbeef-dead-beef-dead-beefdeadbeef --title 'New'",
      detailKind: "tool_started",
      toolName: "update_reminder",
      toolInput: "deadbeef",
    },
    {
      command:
        "coforge reminder snooze --id deadbeef-dead-beef-dead-beefdeadbeef --delay-seconds 60",
      detailKind: "tool_started",
      toolName: "snooze_reminder",
      toolInput: "deadbeef",
    },
    {
      command: "coforge reminder cancel --id deadbeef-dead-beef-dead-beefdeadbeef",
      detailKind: "tool_started",
      toolName: "cancel_reminder",
      toolInput: "deadbeef",
    },
    {
      command: "coforge reminder log --id deadbeef-dead-beef-dead-beefdeadbeef",
      detailKind: "tool_started",
      toolName: "reminder_log",
      toolInput: "deadbeef",
    },
    {
      command: "coforge reminder ack --id deadbeef-dead-beef-dead-beefdeadbeef --revision 3",
      detailKind: "tool_started",
      toolName: "ack_reminder",
      toolInput: "deadbeef",
    },
    {
      command: "coforge reminder dismiss --id deadbeef-dead-beef-dead-beefdeadbeef --revision 3",
      detailKind: "tool_started",
      toolName: "dismiss_reminder",
      toolInput: "deadbeef",
    },
    {
      command: "coforge weekly-report context --subject-type report --subject-id deadbeef",
      detailKind: "tool_started",
      toolName: "weekly_report",
    },
    {
      command: "coforge workspace info --agents",
      detailKind: "tool_started",
      toolName: "coforge_cli",
    },
    {
      command:
        "coforge manual get index --intent 'Learn available CoForge workflows' --reason 'Browse the topic catalog'",
      detailKind: "tool_started",
      toolName: "get_manual",
      toolInput: "index",
    },
    {
      command:
        "coforge manual search 'github pull request' --intent 'Open a PR' --reason 'Find the right command'",
      detailKind: "tool_started",
      toolName: "search_manual",
      toolInput: "github pull request",
    },
    {
      command: "coforge user info @alice",
      detailKind: "tool_started",
      toolName: "get_user_info",
      toolInput: "@alice",
    },
    {
      command: "coforge profile show @scout",
      detailKind: "tool_started",
      toolName: "get_profile",
      toolInput: "@scout",
    },
    { command: "coforge profile show", detailKind: "tool_started", toolName: "get_profile" },
    {
      command: "coforge profile update --display-name Scout",
      detailKind: "tool_started",
      toolName: "update_profile",
    },
    {
      command: "/usr/local/bin/coforge message check",
      detailKind: "checking_messages",
      toolName: "check_messages",
    },
    { command: "coforge whoami --json", detailKind: "tool_started", toolName: "whoami" },
    { command: "coforge version --json", detailKind: "tool_started", toolName: "get_version" },
  ];
  for (const { command, detailKind, toolName, toolInput } of cases) {
    const result = toolActivity("bash", { command });
    expect(result).toMatchObject({
      detailKind,
      detail: toolActivityLabel(toolName),
      entries: [{ kind: "tool_start", toolName, ...(toolInput ? { toolInput } : {}) }],
    });
    if (toolInput === undefined) expect(result.entries[0]).not.toHaveProperty("toolInput");
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
    detail: "Sending message…",
    entries: [{ kind: "tool_start", toolName: "send_message", toolInput: "@bob" }],
  });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("hunter2");
  expect(serialized).not.toContain("sk-liveTESTsecret");
  expect(serialized).not.toContain("Here is the deploy password");
});

test("CoForge CLI tokenising respects quotes and backslashes", () => {
  expect(
    toolActivity("bash", { command: "coforge channel mute --target '#has spaces'" }),
  ).toMatchObject({ entries: [{ toolInput: "#has spaces" }] });
  expect(
    toolActivity("bash", {
      command: 'coforge message search --query "say \\"hi\\" now" --target #general',
    }),
  ).toMatchObject({ entries: [{ toolInput: 'say "hi" now' }] });
  expect(
    toolActivity("bash", { command: "coforge channel mute --target \\#escaped-space" }),
  ).toMatchObject({ entries: [{ toolInput: "#escaped-space" }] });
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
    detail: "Running command…",
    entries: [{ kind: "tool_start", toolName: "bash", toolInput: "coforge" }],
  });
  expect(toolActivity("bash", { command: "bun test packages/daemon" })).toMatchObject({
    detailKind: "running_command",
    detail: "Running command…",
    entries: [{ kind: "tool_start", toolName: "bash", toolInput: "bun test packages/daemon" }],
  });
});
