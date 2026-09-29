import { expect, test } from "bun:test";
import type { TaskCommand, TaskPrincipal } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

/**
 * `TaskBoard.execute` refuses a malformed command as `INVALID_INPUT` before it reads anything; a
 * well-formed one goes on to the database. The board here has a database that answers every
 * query with `DATABASE_REACHED`, so each case shows which side of that line a command falls on.
 */
const DATABASE_REACHED = "DATABASE_REACHED";
const unreachableDatabase = new Proxy(
  {},
  {
    get() {
      return new Proxy(() => {}, {
        get() {
          return () => Promise.reject(new Error(DATABASE_REACHED));
        },
      });
    },
  },
) as PrismaClient;
const board = new TaskBoard(unreachableDatabase);

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const person: TaskPrincipal = {
  workspaceId: WORKSPACE_ID,
  userId: "22222222-2222-4222-8222-222222222222",
};
const agent: TaskPrincipal = {
  workspaceId: WORKSPACE_ID,
  agentId: "33333333-3333-4333-8333-333333333333",
};
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";

/** A person's command in one conversation, with the given fields over it. */
const command = (fields: Partial<TaskCommand> & Pick<TaskCommand, "operation">): TaskCommand => ({
  idempotencyKey: "request-1",
  conversationId: CONVERSATION_ID,
  ...fields,
});

const refused: [string, TaskCommand][] = [
  ["an unknown operation", command({ operation: "archive" as TaskCommand["operation"] })],
  ["no idempotency key", command({ operation: "list", idempotencyKey: "" })],
  [
    "neither a conversation, a target nor mine",
    command({ operation: "list", conversationId: undefined }),
  ],
  ["a conversation and a target", command({ operation: "list", target: "#general" })],
  ["a conversation and mine", command({ operation: "list", mine: true })],
  [
    "a target naming a thread",
    command({ operation: "list", conversationId: undefined, target: "#general:abcd1234" }),
  ],
  ["a zero number", command({ operation: "history", number: 0 })],
  ["a fractional number", command({ operation: "history", number: 1.5 })],
  [
    "a negative expected revision",
    command({ operation: "update", number: 1, status: "done", expectedRevision: -1 }),
  ],
  [
    "a fractional expected revision",
    command({ operation: "update", number: 1, status: "done", expectedRevision: 0.5 }),
  ],
  ["an unknown status", command({ operation: "list", status: "blocked" as TaskCommand["status"] })],
  ["status all outside list", command({ operation: "update", number: 1, status: "all" })],
  ["a zero among numbers", command({ operation: "claim", numbers: [1, 0] })],
  ["a blank message id", command({ operation: "claim", messageIds: ["m-1", " "] })],
  [
    "an expected revision on claim",
    command({ operation: "claim", number: 1, expectedRevision: 0 }),
  ],
  [
    "an expected revision on delete",
    command({ operation: "delete", number: 1, expectedRevision: 0 }),
  ],
  ["an assignee on unassign", command({ operation: "unassign", number: 1, assignee: "@ada" })],
  ["a status on claim", command({ operation: "claim", number: 1, status: "done" })],
  ["a create with no title", command({ operation: "create" })],
  ["a create with no titles", command({ operation: "create", titles: [] })],
  ["a create with title and titles", command({ operation: "create", title: "a", titles: ["b"] })],
  ["a create with a blank title", command({ operation: "create", titles: ["a", "  "] })],
  [
    "a create title over 8000 characters",
    command({ operation: "create", title: "x".repeat(8_001) }),
  ],
  ["a create with a number", command({ operation: "create", title: "a", number: 1 })],
  ["a create with a message id", command({ operation: "create", title: "a", messageId: "m-1" })],
  ["an amend with a blank title", command({ operation: "amend", number: 1, title: " " })],
  [
    "an amend title over 10000 characters",
    command({ operation: "amend", number: 1, title: "x".repeat(10_001) }),
  ],
  [
    "an amend title that is not text",
    command({ operation: "amend", number: 1, title: 7 as unknown as string }),
  ],
  [
    "an amend description over 50000 characters",
    command({ operation: "amend", number: 1, description: "x".repeat(50_001) }),
  ],
  [
    "an amend description that is not text",
    command({ operation: "amend", number: 1, description: 7 as unknown as string }),
  ],
  ...(
    ["unclaim", "update", "assign", "unassign", "amend", "history", "delete", "receipt"] as const
  ).map((operation): [string, TaskCommand] => [
    `${operation} without a number`,
    command({ operation, ...(operation === "update" && { status: "done" }) }),
  ]),
  ["an update without a status", command({ operation: "update", number: 1 })],
  ["a convert that names nothing", command({ operation: "convert" })],
  ["a claim that names nothing", command({ operation: "claim", numbers: [], messageIds: [] })],
  ["numbers on convert", command({ operation: "convert", number: 1, numbers: [2] })],
  ["message ids on list", command({ operation: "list", messageIds: ["m-1"] })],
];

test.each(refused)("execute refuses %s as INVALID_INPUT before reading", async (_, input) => {
  await expect(board.execute(person, input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

const accepted: [string, TaskPrincipal, TaskCommand][] = [
  ["a person's list", person, command({ operation: "list" })],
  ["a list of every status", person, command({ operation: "list", status: "all" })],
  ["a list of one status", person, command({ operation: "list", status: "in_review" })],
  ["a create with one title", person, command({ operation: "create", title: "x".repeat(8_000) })],
  ["a create with titles", person, command({ operation: "create", titles: ["a", "b"] })],
  ["a convert by message id", person, command({ operation: "convert", messageId: "m-1" })],
  ["a claim by numbers", person, command({ operation: "claim", numbers: [1, 2] })],
  ["a claim by message ids", person, command({ operation: "claim", messageIds: ["m-1"] })],
  ["a claim by number", person, command({ operation: "claim", number: 3 })],
  [
    "an unclaim at a revision",
    person,
    command({ operation: "unclaim", number: 1, expectedRevision: 0 }),
  ],
  [
    "an update at a revision",
    person,
    command({ operation: "update", number: 1, status: "closed", expectedRevision: 4 }),
  ],
  [
    "an assign",
    person,
    command({ operation: "assign", number: 1, assignee: "@ada", expectedRevision: 1 }),
  ],
  ["an unassign", person, command({ operation: "unassign", number: 1, expectedRevision: 1 })],
  [
    "an amend at the length limits",
    person,
    command({
      operation: "amend",
      number: 1,
      title: "x".repeat(10_000),
      description: "y".repeat(50_000),
    }),
  ],
  [
    "an amend clearing the description",
    person,
    command({ operation: "amend", number: 1, description: null }),
  ],
  ["a history", person, command({ operation: "history", number: 1 })],
  ["a delete", person, command({ operation: "delete", number: 1 })],
  ["a receipt", person, command({ operation: "receipt", number: 1 })],
  [
    "an Agent's list by target",
    agent,
    command({ operation: "list", conversationId: undefined, target: "#general" }),
  ],
  [
    "an Agent's own list",
    agent,
    command({ operation: "list", conversationId: undefined, mine: true, status: "all" }),
  ],
];

test.each(accepted)("execute takes %s past validation", async (_, principal, input) => {
  await expect(board.execute(principal, input)).rejects.toThrow(DATABASE_REACHED);
});
