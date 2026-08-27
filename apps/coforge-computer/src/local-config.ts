import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type CurrentProfile = { serverUrl: string };
export type WorkspaceSelection = { id: string; slug: string };
export type RegisteredWorkspaceConnection = WorkspaceSelection & {
  computerId: string;
  connectionId: string;
};

export interface ComputerConfig {
  saveCurrentProfile(profile: CurrentProfile): Promise<void>;
  loadCurrentProfile(): Promise<CurrentProfile>;
  saveWorkspace(workspace: WorkspaceSelection): Promise<string>;
  saveRegistration?(
    registration: RegisteredWorkspaceConnection,
    daemonCredential: string,
  ): Promise<string>;
  discardRegistration?(registration: RegisteredWorkspaceConnection): Promise<void>;
}

export class FileComputerConfig implements ComputerConfig {
  constructor(private readonly directory: string) {}

  async saveCurrentProfile(profile: CurrentProfile): Promise<void> {
    await writeJson(join(this.directory, "profile.json"), { server_url: profile.serverUrl });
  }

  async loadCurrentProfile(): Promise<CurrentProfile> {
    const value = JSON.parse(await readFile(join(this.directory, "profile.json"), "utf8")) as {
      server_url?: unknown;
    };
    if (typeof value.server_url !== "string" || value.server_url.length === 0) {
      throw new Error("current profile is invalid");
    }
    return { serverUrl: value.server_url };
  }

  async saveWorkspace(workspace: WorkspaceSelection): Promise<string> {
    const directoryName = Buffer.from(workspace.id, "utf8").toString("base64url");
    const configPath = join(this.directory, "workspaces", directoryName, "config.json");
    await writeJson(configPath, { workspace_id: workspace.id });
    return configPath;
  }

  async saveRegistration(
    registration: RegisteredWorkspaceConnection,
    _daemonCredential: string,
  ): Promise<string> {
    const directoryName = Buffer.from(registration.id, "utf8").toString("base64url");
    const configPath = join(this.directory, "workspaces", directoryName, "config.json");
    await writeJson(configPath, {
      workspace_id: registration.id,
      computer_id: registration.computerId,
      connection_id: registration.connectionId,
    });
    return configPath;
  }

  async discardRegistration(registration: RegisteredWorkspaceConnection): Promise<void> {
    // Registration files are written atomically. A future credential-backed
    // implementation may replace this with an atomic transaction/rollback.
    const { rm } = await import("node:fs/promises");
    const directoryName = Buffer.from(registration.id, "utf8").toString("base64url");
    await rm(join(this.directory, "workspaces", directoryName), { recursive: true, force: true });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}
