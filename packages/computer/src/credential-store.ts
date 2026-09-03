import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

import type { Credential, CredentialStore } from "./login";
import { loginError } from "./errors";
import { resolveComputerCredentialsDirectory } from "./paths";

/** File-backed credentials rooted by COFORGE_COMPUTER_* environment variables. */
export class FileCredentialStore implements CredentialStore {
  constructor(
    private readonly directory = resolveComputerCredentialsDirectory({
      platform: process.platform,
      homeDirectory: homedir(),
      environment: process.env,
    }),
  ) {}

  async save(serverUrl: string, credential: Credential): Promise<void> {
    try {
      const path = this.pathFor(serverUrl);
      const directory = dirname(path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const temporaryPath = join(directory, `.${basename(path)}.${crypto.randomUUID()}.tmp`);
      await writeFile(temporaryPath, `${JSON.stringify(credential, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, path);
      await chmod(path, 0o600);
    } catch {
      throw loginError("AUTH_CREDENTIAL_STORE_UNAVAILABLE", "The credential file is unavailable.");
    }
  }

  async load(serverUrl: string): Promise<Credential | null> {
    try {
      const value = await readFile(this.pathFor(serverUrl), "utf8");
      const credential = JSON.parse(value) as Partial<Credential>;
      if (
        typeof credential.accessToken !== "string" ||
        !credential.accessToken ||
        typeof credential.tokenType !== "string" ||
        !credential.tokenType
      ) {
        throw new Error("stored credential is invalid");
      }
      return credential as Credential;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw loginError("AUTH_CREDENTIAL_STORE_UNAVAILABLE", "The credential file is unavailable.");
    }
  }

  private pathFor(serverUrl: string): string {
    const url = new URL(serverUrl);
    const server = url.hostname.toLowerCase() + (url.port ? `-${url.port}` : "");
    return join(this.directory, `${server}.json`);
  }
}
