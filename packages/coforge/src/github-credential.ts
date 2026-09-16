import type { GitHubCredentialResponse } from "@lrm/coforge-sdk/agent";
import { delimiter, dirname, resolve } from "node:path";

type CredentialLookup = () => Promise<GitHubCredentialResponse>;

/** Implements Git's credential-helper protocol for HTTPS repositories on github.com. */
export async function runGitHubCredentialHelper(
  operation: string | undefined,
  input: string,
  lookup: CredentialLookup,
) {
  if (operation === "store" || operation === "erase") return "";
  if (operation !== "get") throw new Error("GitHub credential helper operation is invalid");
  const fields = new Map<string, string>();
  for (const line of input.split(/\r?\n/)) {
    if (!line) break;
    const separator = line.indexOf("=");
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  if (fields.get("protocol") !== "https" || fields.get("host") !== "github.com") return "";
  const path = fields
    .get("path")
    ?.replace(/^\/+/, "")
    .replace(/\.git$/i, "");
  if (!path || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path))
    throw new Error("GitHub credential repository is invalid");
  const credential = await lookup();
  return `username=${credential.username}\npassword=${credential.password}\n\n`;
}

/** Runs the host's GitHub CLI with a fresh user token scoped to this child process. */
export async function runGitHubCli(
  args: readonly string[],
  lookup: CredentialLookup,
  environment: Record<string, string | undefined> = Bun.env,
  executablePath = process.execPath,
) {
  const wrapperDirectory = resolve(dirname(executablePath));
  const path = (environment.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry && resolve(entry) !== wrapperDirectory)
    .join(delimiter);
  const executable = Bun.which("gh", { PATH: path });
  if (!executable) throw new Error("GitHub CLI is not installed");
  const credential = await lookup();
  const process = Bun.spawn([executable, ...args], {
    env: { ...environment, PATH: path, GH_TOKEN: credential.password },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return process.exited;
}
