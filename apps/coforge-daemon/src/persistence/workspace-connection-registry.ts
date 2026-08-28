import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkspaceConnection } from "../workspace-worker/supervisor";

/** Durable, non-secret metadata for connections configured on this machine. */
export interface WorkspaceConnectionRegistry {
  list(): Promise<WorkspaceConnection[]>;
  upsert(connection: WorkspaceConnection): Promise<void>;
  delete(workspaceId: string, computerId: string): Promise<void>;
}

export class FileWorkspaceConnectionRegistry implements WorkspaceConnectionRegistry {
  readonly #path: string;
  constructor(stateDirectory: string) {
    this.#path = join(stateDirectory, "workspace-connections.json");
  }
  async list(): Promise<WorkspaceConnection[]> {
    try {
      return JSON.parse(await Bun.file(this.#path).text()) as WorkspaceConnection[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  async upsert(connection: WorkspaceConnection): Promise<void> {
    const entries = (await this.list()).filter(
      (entry) =>
        entry.workspaceId !== connection.workspaceId || entry.computerId !== connection.computerId,
    );
    entries.push(connection);
    await this.#write(entries);
  }
  async delete(workspaceId: string, computerId: string): Promise<void> {
    await this.#write(
      (await this.list()).filter(
        (entry) => entry.workspaceId !== workspaceId || entry.computerId !== computerId,
      ),
    );
  }
  async #write(entries: WorkspaceConnection[]): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.#path), 0o700);
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(entries) + "\n", { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#path);
    await chmod(this.#path, 0o600);
  }
}
