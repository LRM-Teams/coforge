import pc from "picocolors";

import { normalizeServerUrl } from "./oauth-device-client";
import { loginError } from "./errors";
import { terminalText } from "./terminal-output";

export type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
};

export type Credential = {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresInSeconds?: number;
};

export type TokenPollResult =
  | { status: "authorized"; credential: Credential }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "network_timeout" };

export type AccessibleWorkspace = {
  id: string;
  slug: string;
  name: string;
};

export interface DeviceAuthorizationClient {
  authorize(serverUrl: string): Promise<DeviceAuthorization>;
  pollToken(deviceCode: string, timeoutMilliseconds?: number): Promise<TokenPollResult>;
  listWorkspaces(credential: Credential): Promise<AccessibleWorkspace[]>;
}

export interface CredentialStore {
  save(serverUrl: string, credential: Credential): Promise<void>;
}

export type ComputerLoginOptions = {
  client: DeviceAuthorizationClient;
  store: CredentialStore;
  config: { saveCurrentProfile(profile: { serverUrl: string }): Promise<void> };
  writeLine: (line: string) => void;
  writeProgressLine?: (line: string) => void;
  sleep: (milliseconds: number) => Promise<void>;
  now?: () => number;
  colors?: Pick<typeof pc, "bold" | "cyan" | "green">;
};

export class ComputerLogin {
  constructor(private readonly options: ComputerLoginOptions) {}

  async run(input: {
    serverUrl: string;
    json?: boolean;
  }): Promise<{ serverUrl: string; workspaces: AccessibleWorkspace[] }> {
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const colors = this.options.colors ?? pc;
    const writeInstruction = input.json
      ? (this.options.writeProgressLine ?? this.options.writeLine)
      : this.options.writeLine;
    if (!input.json) {
      this.options.writeLine(colors.bold("CoForge Computer login"));
      this.options.writeLine(`Server:      ${serverUrl}`);
    }
    const authorization = await this.options.client.authorize(serverUrl);
    if (!input.json) writeInstruction("");
    writeInstruction(input.json ? "Complete device authorization:" : "To sign in:");
    writeInstruction(`Verify at:   ${colors.cyan(terminalText(authorization.verificationUri))}`);
    writeInstruction(`User code:   ${colors.bold(terminalText(authorization.userCode))}`);
    if (!input.json) writeInstruction("");
    (this.options.writeProgressLine ?? this.options.writeLine)("Waiting for authorization…");

    const now = this.options.now ?? (() => performance.now());
    const deadline = now() + authorization.expiresInSeconds * 1_000;
    let intervalMilliseconds = authorization.intervalSeconds * 1_000;
    let token: TokenPollResult;
    do {
      let remainingMilliseconds = deadline - now();
      if (intervalMilliseconds >= remainingMilliseconds) {
        throw loginError("AUTH_DEVICE_CODE_EXPIRED", "The device authorization code expired.");
      }
      await this.options.sleep(intervalMilliseconds);
      remainingMilliseconds = deadline - now();
      if (remainingMilliseconds <= 0) {
        throw loginError("AUTH_DEVICE_CODE_EXPIRED", "The device authorization code expired.");
      }
      token = await this.options.client.pollToken(authorization.deviceCode, remainingMilliseconds);
      if (token.status === "slow_down" || token.status === "network_timeout") {
        intervalMilliseconds += 5_000;
      }
      if (token.status !== "authorized" && deadline - now() <= 0) {
        throw loginError("AUTH_DEVICE_CODE_EXPIRED", "The device authorization code expired.");
      }
    } while (token.status !== "authorized");

    await this.options.store.save(serverUrl, token.credential);
    try {
      await this.options.config.saveCurrentProfile({ serverUrl });
    } catch {
      throw loginError("AUTH_PROFILE_WRITE_FAILED", "Could not save the current login profile.");
    }
    const workspaces = await this.options.client.listWorkspaces(token.credential);
    if (input.json) {
      this.options.writeLine(
        JSON.stringify({
          ok: true,
          server_url: serverUrl,
          workspaces,
          binding_created: false,
          daemon_started: false,
        }),
      );
    } else {
      this.options.writeLine(`Workspaces:  ${workspaces.length}`);
      for (const workspace of workspaces) {
        this.options.writeLine(
          `  - ${terminalText(workspace.name)} (${terminalText(workspace.slug)})`,
        );
      }
      this.options.writeLine("Result:      Login complete. No Workspace binding was created.");
    }
    return { serverUrl, workspaces };
  }
}
