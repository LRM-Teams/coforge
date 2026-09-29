import type { TaskCommand } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";

/**
 * The shape a Task command must have before `TaskBoard.execute` reads anything: its operation,
 * exactly one of a conversation, a target or `mine`, and the fields that operation takes. A
 * malformed command is `INVALID_INPUT`; who may act on which conversation is TaskBoard's.
 */
export function validateTaskCommand(command: TaskCommand) {
  const operations = [
    "list",
    "create",
    "convert",
    "claim",
    "unclaim",
    "update",
    "assign",
    "unassign",
    "amend",
    "history",
    "delete",
    "receipt",
  ];
  if (!operations.includes(command.operation) || !command.idempotencyKey)
    throw new AppError("INVALID_INPUT");
  if ((command.conversationId ? 1 : 0) + (command.target ? 1 : 0) + (command.mine ? 1 : 0) !== 1)
    throw new AppError("INVALID_INPUT");
  if (command.target?.includes(":")) throw new AppError("INVALID_INPUT");
  if (command.number !== undefined && (!Number.isSafeInteger(command.number) || command.number < 1))
    throw new AppError("INVALID_INPUT");
  if (
    command.expectedRevision !== undefined &&
    (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)
  )
    throw new AppError("INVALID_INPUT");
  if (
    command.status !== undefined &&
    !["all", "todo", "in_progress", "in_review", "done", "closed"].includes(command.status)
  )
    throw new AppError("INVALID_INPUT");
  if (command.status === "all" && command.operation !== "list") throw new AppError("INVALID_INPUT");
  if (command.numbers?.some((number) => !Number.isSafeInteger(number) || number < 1))
    throw new AppError("INVALID_INPUT");
  if (command.messageIds?.some((messageId) => !messageId.trim()))
    throw new AppError("INVALID_INPUT");
  if (
    command.operation !== "update" &&
    command.operation !== "unclaim" &&
    command.operation !== "assign" &&
    command.operation !== "unassign" &&
    command.operation !== "amend" &&
    command.expectedRevision !== undefined
  )
    throw new AppError("INVALID_INPUT");
  if (command.operation === "unassign" && command.assignee !== undefined)
    throw new AppError("INVALID_INPUT");
  if (
    command.operation !== "update" &&
    command.operation !== "list" &&
    command.status !== undefined
  )
    throw new AppError("INVALID_INPUT");
  if (command.operation === "create") {
    const titles = command.titles ?? (command.title === undefined ? [] : [command.title]);
    if (
      titles.length === 0 ||
      (command.title !== undefined && command.titles !== undefined) ||
      titles.some((value) => !value.trim() || value.trim().length > 8_000)
    )
      throw new AppError("INVALID_INPUT");
    if (command.number !== undefined || command.messageId !== undefined)
      throw new AppError("INVALID_INPUT");
  }
  if (command.operation === "amend") {
    if (
      command.title !== undefined &&
      (typeof command.title !== "string" ||
        !command.title.trim() ||
        command.title.trim().length > 10_000)
    )
      throw new AppError("INVALID_INPUT");
    if (
      command.description !== undefined &&
      command.description !== null &&
      (typeof command.description !== "string" || command.description.length > 50_000)
    )
      throw new AppError("INVALID_INPUT");
  }
  if (
    ["unclaim", "update", "assign", "unassign", "amend", "history", "delete", "receipt"].includes(
      command.operation,
    ) &&
    !command.number
  )
    throw new AppError("INVALID_INPUT");
  if (command.operation === "update" && !command.status) throw new AppError("INVALID_INPUT");
  if (
    ["convert", "claim"].includes(command.operation) &&
    !command.number &&
    !command.messageId &&
    !command.numbers?.length &&
    !command.messageIds?.length
  )
    throw new AppError("INVALID_INPUT");
  if (command.operation !== "claim" && (command.numbers || command.messageIds))
    throw new AppError("INVALID_INPUT");
}
