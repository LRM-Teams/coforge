import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type CurrentProfile = { serverUrl: string };
export type WorkspaceSelection = { id: string; slug: string };

export interface ComputerConfig {
  saveCurrentProfile(profile: CurrentProfile): Promise<void>;
  loadCurrentProfile(): Promise<CurrentProfile>;
  saveWorkspace(workspace: WorkspaceSelection): Promise<string>;
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
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}
