import { unlink } from "node:fs/promises";
import { userInfo } from "node:os";

/**
 * The plumbing every Windows Scheduled Task writer in the daemon shares: resolving the principal's
 * `DOMAIN\user`, writing task XML the way `schtasks` reads it, cleaning the temp file up, and
 * running `schtasks` itself.
 *
 * There were four copies of this across `daemon-host/windows-task.ts` (the daemon's own task),
 * `platform/computer-upgrade-launcher.ts` and `platform/computer-upgrade-sweep.ts` (the one-shot
 * upgrade task), including **three names for the same spawn** (`runCommand`, `runSchtasks`,
 * `defaultSchtasks`). The UTF-16 requirement below was written down in only one of the two copies
 * that depend on it — which is the kind of thing a single copy prevents.
 */

/** Resolves `DOMAIN\user` for Task Scheduler principals; falls back to the OS username. */
export function windowsTaskUserId(
  environment: NodeJS.ProcessEnv = process.env,
  username: string = userInfo().username,
): string {
  const domain = environment.USERDOMAIN?.trim();
  const envUser = environment.USERNAME?.trim();
  if (domain && envUser) return `${domain}\\${envUser}`;
  return username;
}

/** `schtasks /Create /XML` requires UTF-16; the BOM lets it detect the encoding. */
export async function writeUtf16XmlFile(path: string, content: string): Promise<void> {
  await Bun.write(path, Buffer.from(`\uFEFF${content}`, "utf16le"));
}

/** Removes a task XML file that may already be gone: the cleanup path runs on failures too. */
export async function removeFileQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // already gone
  }
}

/**
 * Runs `schtasks` for its exit code only. Task output is not read anywhere, and inheriting stdio
 * would leak `schtasks` chatter into the daemon's own log.
 */
export async function runSchtasks(command: string[]): Promise<number> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return await child.exited;
}
