import type { AccessibleWorkspace, Credential } from "./login";
import type { ComputerConfig } from "./local-config";
import { CliError, setupError } from "./errors";
import { terminalText } from "./terminal-output";

export interface SetupCredentialStore {
  load(serverUrl: string): Promise<Credential | null>;
}

export interface SetupWorkspaceClient {
  listWorkspaces(serverUrl: string, credential: Credential): Promise<AccessibleWorkspace[]>;
}

export type ComputerSetupOptions = {
  config: Pick<ComputerConfig, "loadCurrentProfile" | "saveWorkspace">;
  credentials: SetupCredentialStore;
  client: SetupWorkspaceClient;
  selectWorkspace: (workspaces: AccessibleWorkspace[]) => Promise<AccessibleWorkspace>;
  writeLine: (line: string) => void;
};

export class ComputerSetup {
  constructor(private readonly options: ComputerSetupOptions) {}

  async run(input: { workspaceSlug?: string; json?: boolean }): Promise<{
    workspace: AccessibleWorkspace;
    configPath: string;
  }> {
    const profile = await this.loadProfile();
    const credential = await this.options.credentials.load(profile.serverUrl);
    if (!credential) {
      throw setupError("SETUP_NOT_LOGGED_IN", "No login credential exists for the current server.");
    }

    const workspaces = await this.options.client.listWorkspaces(profile.serverUrl, credential);
    if (workspaces.length === 0) {
      throw setupError("SETUP_NO_WORKSPACES", "The current account cannot access any Workspaces.");
    }
    const workspace = input.workspaceSlug
      ? this.findWorkspace(workspaces, input.workspaceSlug)
      : await this.options.selectWorkspace(workspaces);

    let configPath: string;
    try {
      configPath = await this.options.config.saveWorkspace({
        id: workspace.id,
        slug: workspace.slug,
      });
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw setupError("SETUP_CONFIG_WRITE_FAILED", "Could not save the Workspace configuration.");
    }

    if (input.json) {
      this.options.writeLine(
        JSON.stringify({
          ok: true,
          workspace,
          config_path: configPath,
          server_binding_created: false,
          daemon_started: false,
        }),
      );
    } else {
      this.options.writeLine(
        `Workspace configured: ${terminalText(workspace.name)} (${terminalText(workspace.slug)})`,
      );
      this.options.writeLine(`Workspace ID:         ${terminalText(workspace.id)}`);
      this.options.writeLine(`Configuration:        ${terminalText(configPath)}`);
      this.options.writeLine(
        "Result:               No server binding was created. No daemon was started.",
      );
    }
    return { workspace, configPath };
  }

  private async loadProfile(): Promise<{ serverUrl: string }> {
    try {
      return await this.options.config.loadCurrentProfile();
    } catch {
      throw setupError("SETUP_NOT_LOGGED_IN", "No current login profile was found.");
    }
  }

  private findWorkspace(workspaces: AccessibleWorkspace[], slug: string): AccessibleWorkspace {
    const workspace = workspaces.find((candidate) => candidate.slug === slug);
    if (!workspace) {
      throw setupError(
        "SETUP_WORKSPACE_NOT_FOUND",
        `Workspace slug '${terminalText(slug)}' is not accessible.`,
      );
    }
    return workspace;
  }
}
