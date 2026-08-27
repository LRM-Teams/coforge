export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export const LOGIN_HINTS = {
  AUTH_DEVICE_CODE_CANCELLED: "Run `coforge-computer login` again when you are ready to sign in.",
  AUTH_CREDENTIAL_STORE_UNAVAILABLE:
    "Unlock or start your operating system credential service, then rerun login.",
  AUTH_DEVICE_CODE_EXPIRED: "Run `coforge-computer login` again to request a new code.",
  AUTH_FAILED: "Check the server configuration, then rerun login.",
  AUTH_INVALID_SERVER: "Use an HTTPS server URL without credentials, a query, or a fragment.",
  AUTH_NETWORK_ERROR: "Check the server URL and network connection, then rerun login.",
  AUTH_PROFILE_WRITE_FAILED: "Check the configuration directory permissions, then rerun login.",
  AUTH_WORKSPACE_LIST_FAILED: "Check your account access and rerun login.",
} as const;

export type LoginErrorCode = keyof typeof LOGIN_HINTS;

export function loginError(code: LoginErrorCode, message: string): CliError {
  return new CliError(code, message, LOGIN_HINTS[code]);
}

export const SETUP_HINTS = {
  SETUP_CONFIG_WRITE_FAILED: "Check the configuration directory permissions, then rerun setup.",
  SETUP_FAILED: "Check your login and server configuration, then rerun setup.",
  SETUP_NOT_LOGGED_IN: "Run `coforge-computer login` before setup.",
  SETUP_NO_WORKSPACES: "Ask a Workspace administrator to grant access, then rerun setup.",
  SETUP_SELECTION_INVALID: "Choose one of the numbered Workspaces and rerun setup.",
  SETUP_WORKSPACE_NOT_FOUND: "Use a slug shown by login, or omit it to choose interactively.",
} as const;

export type SetupErrorCode = keyof typeof SETUP_HINTS;

export function setupError(code: SetupErrorCode, message: string): CliError {
  return new CliError(code, message, SETUP_HINTS[code]);
}
