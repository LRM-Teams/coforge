import {
  actionCardActionSchema,
  validateActionCardAction as validateActionCardCrossFields,
  type ActionCardAction,
} from "@lrm/coforge-sdk/agent";
import { CliError } from "./cli-error";

/**
 * `coforge action prepare` accepts a real shell heredoc (the delimiter never reaches this
 * process; the shell strips it) or a literal body whose first and last lines are this delimiter,
 * for callers that cannot rely on shell heredoc semantics. Raft Computer 1.0.32 uses
 * `RAFTACTION` for the same purpose (see `docs/agents/reference-cli-research.md`).
 */
export const ACTION_HEREDOC_DELIMITER = "COFORGEACTION";

function missingActionMessage(): string {
  return [
    "No action JSON received on stdin.",
    "Pipe a JSON ActionCardAction object (for example channel:create / agent:create / channel:add_member) into coforge action prepare:",
    `  coforge action prepare --target "#channel" <<'${ACTION_HEREDOC_DELIMITER}'`,
    '  {"type":"channel:create","name":"demo","visibility":"public"}',
    `  ${ACTION_HEREDOC_DELIMITER}`,
  ].join("\n");
}

/**
 * Strips a leading/trailing `COFORGEACTION` delimiter line pair when both are present; otherwise
 * returns the trimmed input unchanged. Does not parse JSON.
 */
export function extractActionCardJson(raw: string): string {
  const withoutBom = raw.replace(/^﻿/, "");
  const trimmed = withoutBom.trim();
  const lines = trimmed.split("\n").map((line) => line.replace(/\r$/, ""));
  if (
    lines.length >= 2 &&
    lines[0]?.trim() === ACTION_HEREDOC_DELIMITER &&
    lines[lines.length - 1]?.trim() === ACTION_HEREDOC_DELIMITER
  ) {
    return lines.slice(1, -1).join("\n").trim();
  }
  return trimmed;
}

/** Reads and parses the JSON action body from stdin text; throws a typed `CliError` on failure. */
export function parseActionCardInput(raw: string): unknown {
  if (raw.trim().length === 0)
    throw new CliError({
      code: "MISSING_ACTION",
      message: missingActionMessage(),
      retryable: false,
    });
  const json = extractActionCardJson(raw);
  if (json.length === 0)
    throw new CliError({
      code: "MISSING_ACTION",
      message: missingActionMessage(),
      retryable: false,
    });
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new CliError({
      code: "INVALID_JSON",
      message: `Action JSON failed to parse: ${error instanceof Error ? error.message : String(error)}`,
      retryable: false,
    });
  }
}

/**
 * Local zod validation, then the cross-field rule (`validateActionCardAction`). Both failures map
 * to `INVALID_ACTION` with a joined issue list, matching Raft's `action prepare` local validation.
 */
export function toActionCardAction(json: unknown): ActionCardAction {
  const parsed = actionCardActionSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new CliError({
      code: "INVALID_ACTION",
      message: `Action failed validation: ${issues}`,
      retryable: false,
    });
  }
  const crossFieldError = validateActionCardCrossFields(parsed.data);
  if (crossFieldError)
    throw new CliError({
      code: "INVALID_ACTION",
      message: `Action failed validation: ${crossFieldError}`,
      retryable: false,
    });
  return parsed.data;
}
