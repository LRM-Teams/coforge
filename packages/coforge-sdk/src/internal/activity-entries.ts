import { codePointLength } from "./truncate";

export type ActivitySubagent = { parentToolUseId: string };
export type ActivityTrajectoryEntry = (
  | { kind: "text" | "thinking"; text: string }
  | { kind: "tool_start"; toolName: string; toolInput?: string }
  | { kind: "system"; title: string; text: string }
) & { subagent?: ActivitySubagent };

// Eight entries permit bounded batching (at most ~64KiB of UTF-8 text).
export function parseActivityEntries(value: unknown): ActivityTrajectoryEntry[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error("invalid activity entries");
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("invalid activity entry");
    const item = entry as Record<string, unknown>;
    let subagent: ActivitySubagent | undefined;
    if (item.subagent !== undefined) {
      const lineage = item.subagent as Record<string, unknown> | null;
      if (!lineage || !validName(lineage.parentToolUseId))
        throw new Error("invalid activity lineage");
      subagent = { parentToolUseId: lineage.parentToolUseId };
    }
    const scope = subagent ? { subagent } : {};
    if (
      item.kind === "tool_start" &&
      validName(item.toolName) &&
      item.text === undefined &&
      item.title === undefined &&
      (item.toolInput === undefined || validToolInput(item.toolInput))
    )
      return {
        kind: "tool_start",
        toolName: item.toolName,
        ...(item.toolInput !== undefined ? { toolInput: item.toolInput as string } : {}),
        ...scope,
      };
    if (
      (item.kind === "text" || item.kind === "thinking") &&
      typeof item.text === "string" &&
      codePointLength(item.text) <= 2000 &&
      item.toolName === undefined &&
      item.toolInput === undefined &&
      item.title === undefined
    )
      return { kind: item.kind, text: item.text, ...scope };
    if (
      item.kind === "system" &&
      validTitle(item.title) &&
      typeof item.text === "string" &&
      codePointLength(item.text) <= 2000 &&
      item.toolName === undefined &&
      item.toolInput === undefined
    )
      return { kind: "system", title: item.title, text: item.text, ...scope };
    throw new Error("invalid activity entry payload");
  });
}

function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    codePointLength(value) <= 128 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

// `toolInput`: the short, already-redacted argument summary. Same
// control-character rejection as `validName`, with a longer cap.
function validToolInput(value: unknown): value is string {
  return (
    typeof value === "string" && codePointLength(value) <= 200 && !/[\x00-\x1f\x7f]/.test(value)
  );
}

function validTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    codePointLength(value) <= 120 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
