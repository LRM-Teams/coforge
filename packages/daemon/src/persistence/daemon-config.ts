import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DaemonConfig } from "../daemon-runtime/runtime";

/** Durable, non-secret configuration for the one Workspace connection. */
export class DaemonConfigStore {
  readonly #path: string;
  readonly #serverHttpUrl: string | undefined;
  constructor(stateDirectory: string, defaults: { serverHttpUrl?: string } = {}) {
    this.#path = join(stateDirectory, "config.json");
    this.#serverHttpUrl = defaults.serverHttpUrl;
  }
  async load(): Promise<DaemonConfig | null> {
    try {
      const config = JSON.parse(await Bun.file(this.#path).text()) as DaemonConfig;
      return config.serverHttpUrl || !this.#serverHttpUrl
        ? config
        : { ...config, serverHttpUrl: this.#serverHttpUrl };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async save(config: DaemonConfig): Promise<void> {
    await this.#write(config);
  }
  async clear(): Promise<void> {
    await rm(this.#path, { force: true });
  }
  async #write(config: DaemonConfig): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.#path), 0o700);
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(config) + "\n", { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#path);
    await chmod(this.#path, 0o600);
  }
}
