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
  AUTH_WORKSPACE_LIST_FAILED: "Check your account access and rerun login.",
} as const;

export type LoginErrorCode = keyof typeof LOGIN_HINTS;

export function loginError(code: LoginErrorCode, message: string): CliError {
  return new CliError(code, message, LOGIN_HINTS[code]);
}
