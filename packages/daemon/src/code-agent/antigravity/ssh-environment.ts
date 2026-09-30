/** agy switches to a separate file-based token store when any of these says it runs inside an SSH
 * session (the binary logs "Using file-based token storage because %s detected"; not in the public
 * docs). A Daemon started from an SSH shell inherits them while the person signed in through the
 * ordinary keychain store, so no agy process may see them. */
const SSH_SESSION_VARIABLES = ["SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY"] as const;

/** `environment` without the SSH session markers agy reads. Applied to the inherited and declared
 * inputs before an Agent's own overrides, so an explicit override still wins. */
export function withoutSshSessionVariables<T extends string | undefined>(
  environment: Readonly<Record<string, T>>,
): Record<string, T> {
  const result = { ...environment };
  for (const name of SSH_SESSION_VARIABLES) delete result[name];
  return result;
}
