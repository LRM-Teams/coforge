import { NO_MESSAGE_SENT_NEXT_ACTION, unknownDeliveryNextAction } from "./cli-error";

/** A refusal the server explained: its HTTP status and, when it named them, code and retryability. */
export type ExplainedRefusal = { status: number; code?: string; retryable?: boolean };

/** What did not happen, for the operations whose refusals say so. */
const NOTHING_DONE: Readonly<Record<string, string | undefined>> = {
  send: "No message was sent",
  upload: "Nothing was uploaded",
  prepare: "No action card was posted",
};

/**
 * The next step for a refusal the server explained. For a send it errs toward "delivery unknown":
 * "No message was sent" is said only for a code known to refuse before anything is committed, or
 * for a 400/403 without a code (the send route's validation, and `AgentSendRejectedError`, whose
 * transaction rolls back). `MESSAGE_REQUEST_IN_PROGRESS` refuses only this request while an
 * earlier one with the same key may still commit.
 */
export function refusalNextAction(
  operation: string,
  { status, code, retryable }: ExplainedRefusal,
  target: string,
): string | undefined {
  const nothingDone = NOTHING_DONE[operation];
  const person = target.split(":")[0] ?? target;
  switch (code) {
    case "MESSAGE_REQUEST_IN_PROGRESS":
      return (
        "An earlier request with this send's idempotency key is still being processed, so " +
        "this message may still be delivered. Do not write it again as a new send. Wait a " +
        `moment, then run \`coforge message send --send-draft --target ${JSON.stringify(target)}\`: ` +
        "the saved draft keeps the same key, so it cannot create a second message."
      );
    case "DM_PEER_NOT_IN_WORKSPACE":
      return (
        `${nothingDone ?? "Nothing was done"}: ${person} has left this Workspace, so this ` +
        "direct message is read-only and running the command again is refused the same way. " +
        `Its history stays readable with \`coforge message read --target ${JSON.stringify(person)}\`; ` +
        "to reach someone, message a person who is still a member."
      );
    case "TARGET_NOT_ACCESSIBLE":
      return (
        `${nothingDone ?? "Nothing was done"}: ${JSON.stringify(target)} is not a target this ` +
        "Agent can use. An @user must be a member of this Workspace (check with " +
        "`coforge user info <name>`) and a #channel one this Agent belongs to. Correct the " +
        "target, then run the command again."
      );
    case "AGENT_DM_RESTRICTED":
      return (
        `${nothingDone ?? "Nothing was done"}: this direct message belongs to a private Agent ` +
        "and is read-only for it, so running the command again is refused the same way. Reply " +
        "in a conversation this Agent may post to."
      );
  }
  if (operation === "send")
    return code === undefined && (status === 400 || status === 403)
      ? NO_MESSAGE_SENT_NEXT_ACTION
      : unknownDeliveryNextAction(target);
  if (nothingDone === undefined || retryable === true) return undefined;
  return `${nothingDone}; fix the problem above, then run the command again.`;
}
