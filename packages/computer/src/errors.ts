export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CliError";
  }
}

/** A setup failure with a stable user-facing stage and the original failure. */
export class ComputerSetupError extends CliError {
  constructor(
    code: SetupErrorCode,
    message: string,
    readonly stage: SetupStage,
    options?: { cause?: unknown },
  ) {
    super(code, message, SETUP_HINTS[code], options);
    this.name = "ComputerSetupError";
  }
}

export type SetupStage =
  | "credentials"
  | "oauth"
  | "workspace-lookup"
  | "computer-registration"
  | "daemon-start"
  | "config-write";

export class RemoteRpcError extends Error {
  readonly kind = "remote-rpc" as const;
  constructor(
    readonly method: string,
    readonly code: string | number | undefined,
    readonly requestId: string | undefined,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RemoteRpcError";
  }
}

export class TransportError extends Error {
  readonly kind = "transport" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransportError";
  }
}

export function safeErrorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : "unknown error";
  return detail.replace(
    /(token|secret|credential|authorization|request body)[^\s]*/gi,
    "$1=[redacted]",
  );
}

export const LOGIN_HINTS = {
  AUTH_DEVICE_CODE_CANCELLED: "Run `coforge-computer login` again when you are ready to sign in.",
  AUTH_CREDENTIAL_STORE_UNAVAILABLE:
    "Unlock or start your operating system credential service, then rerun login.",
  AUTH_DEVICE_CODE_EXPIRED: "Run `coforge-computer login` again to request a new code.",
  // This code is the catch-all for anything login throws that is not already a CliError, so its
  // hint cannot name a single cause. It points at the message, which carries the real one.
  AUTH_FAILED: "See the reason above, then rerun `coforge-computer login`.",
  AUTH_DAEMON_PREFLIGHT_FAILED:
    "Check local Daemon access and install the build matching its environment. Do not delete existing configuration to switch environments.",
  AUTH_BUILD_ENVIRONMENT_MISMATCH:
    "Install the build matching the existing environment. Do not delete the profile to switch environments.",
  AUTH_INVALID_SERVER: "Use an HTTPS server URL without credentials, a query, or a fragment.",
  AUTH_NETWORK_ERROR: "Check the server URL and network connection, then rerun login.",
  AUTH_PROFILE_WRITE_FAILED: "Check the configuration directory permissions, then rerun login.",
  AUTH_PROFILE_READ_FAILED:
    "Repair the Computer profile without changing its environment, then rerun login.",
  AUTH_WORKSPACE_GET_FAILED: "Check the Workspace slug and your account access, then rerun setup.",
  AUTH_WORKSPACE_LIST_FAILED: "Check your account access and rerun login.",
} as const;

export type LoginErrorCode = keyof typeof LOGIN_HINTS;

export function loginError(code: LoginErrorCode, message: string): CliError {
  return new CliError(code, message, LOGIN_HINTS[code]);
}

export const SETUP_HINTS = {
  SETUP_BUILD_ENVIRONMENT_MISMATCH:
    "Install the build matching the existing environment. Do not delete the profile to switch environments.",
  SETUP_CONFIG_READ_FAILED:
    "Repair the Computer profile without changing its environment, then rerun setup.",
  SETUP_OAUTH_FAILED: "Complete OAuth login again, then rerun setup.",
  SETUP_CREDENTIALS_FAILED: "Check the local credential store, then rerun setup.",
  SETUP_WORKSPACE_LOOKUP_FAILED:
    "Check the server connection and Workspace access, then rerun setup.",
  SETUP_COMPUTER_REGISTER_FAILED:
    "Check the server connection and Computer permissions, then rerun setup.",
  SETUP_DAEMON_START_FAILED: "Check the local Daemon and workspace path, then rerun setup.",
  SETUP_CONFIG_WRITE_FAILED: "Check the configuration directory permissions, then rerun setup.",
  SETUP_FAILED: "Check your login and server configuration, then rerun setup.",
  SETUP_NOT_LOGGED_IN: "Complete Device Code login, then rerun setup.",
  SETUP_REGISTRATION_UNAVAILABLE:
    "The approved CoForge RPC transport is not available in this build.",
  SETUP_WORKSPACE_RPC_UNAVAILABLE:
    "Workspace queries are not available until their approved CoForge RPC methods are defined and implemented.",
  SETUP_WORKSPACE_REQUIRED:
    "Run `coforge-computer setup --workspace <slug>` with the Workspace slug shown on its page.",
  SETUP_WORKSPACE_INVALID:
    "Use a Workspace slug of lowercase letters, digits, and hyphens (matching the slug shown on the Workspace page).",
  SETUP_WORKSPACE_NOT_FOUND: "Check the Workspace slug and your account access, then rerun setup.",
} as const;

export type SetupErrorCode = keyof typeof SETUP_HINTS;

export function setupError(
  code: SetupErrorCode,
  message: string,
  stage: SetupStage = "computer-registration",
  cause?: unknown,
): ComputerSetupError {
  return new ComputerSetupError(code, message, stage, { cause });
}
