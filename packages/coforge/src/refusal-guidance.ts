/** What did not happen, for the operations whose refusals say so. */
const NOTHING_DONE: Readonly<Record<string, string | undefined>> = {
  send: "No message was sent",
  upload: "Nothing was uploaded",
  prepare: "No action card was posted",
};

/**
 * The next step for a refusal the server explained with `code` (or with no code at all). A refusal
 * usually means nothing happened, but not always: `MESSAGE_REQUEST_IN_PROGRESS` refuses only this
 * request while an earlier one with the same key may still commit, so delivery stays unknown.
 */
export function refusalNextAction(
  operation: string,
  code: string | undefined,
  target: string,
  retryable: boolean | undefined,
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
  }
  if (nothingDone === undefined || retryable === true) return undefined;
  return `${nothingDone}; fix the problem above, then run the command again.`;
}
