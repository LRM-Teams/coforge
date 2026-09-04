import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export class AgentAppInboxPersistence {
  readonly #path: string;

  constructor(stateDirectory: string, workspaceId: string, agentId: string) {
    if (!stateDirectory) throw new Error("App Inbox state directory is required");
    if (!SAFE_SCOPE.test(workspaceId) || !SAFE_SCOPE.test(agentId))
      throw new Error("invalid App Inbox Workspace or Agent path scope");
    this.#path = join(stateDirectory, "app-inbox", workspaceId, agentId, "items.json");
  }

  async read(): Promise<unknown[] | null> {
    if (!(await Bun.file(this.#path).exists())) return null;
    let envelope: unknown;
    try {
      envelope = JSON.parse(await Bun.file(this.#path).text());
    } catch {
      throw new Error(`App Inbox persisted data is corrupt: ${this.#path}`);
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
      throw new Error(`App Inbox persisted data is corrupt: ${this.#path}`);
    const value = envelope as Record<string, unknown>;
    if (value.version !== 1 || !Array.isArray(value.items))
      throw new Error(`App Inbox persisted data is corrupt: ${this.#path}`);
    return value.items;
  }

  async write(items: readonly unknown[]): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.#path), 0o700);
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, items }) + "\n", { mode: 0o600 });
    await rename(temporary, this.#path);
    await chmod(this.#path, 0o600);
  }
}
