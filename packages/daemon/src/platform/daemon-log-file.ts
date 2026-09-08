import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join, parse, relative, resolve, sep } from "node:path";

const DAEMON_LOG_FILE = "daemon.jsonl";

export async function prepareDaemonLogFile(dataDirectory: string): Promise<string> {
  const directory = join(dataDirectory, "logs", "daemon");
  const path = daemonLogPath(dataDirectory);
  await ensureDirectoryTree(dataDirectory);
  await ensureProtectedDirectory(join(dataDirectory, "logs"));
  await ensureProtectedDirectory(directory);
  for (let index = 0; index <= 5; index++) {
    const candidate = index === 0 ? path : `${path}.${index}`;
    const status = await lstat(candidate).catch((error: unknown) => {
      if (isMissingPathError(error)) return undefined;
      throw error;
    });
    if (status?.isSymbolicLink())
      throw new Error("Daemon log path must not contain symbolic links");
    if (status && !status.isFile()) throw new Error("Daemon log files must be regular files");
    if (status) await chmod(candidate, 0o600);
  }
  const activeFile = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_APPEND |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    0o600,
  );
  await activeFile.chmod(0o600);
  await activeFile.close();
  return path;
}

export function daemonLogPath(dataDirectory: string): string {
  return join(dataDirectory, "logs", "daemon", DAEMON_LOG_FILE);
}

async function ensureDirectoryTree(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, component);
    await ensureDirectory(current);
  }
  await chmod(absolute, 0o700);
}

async function ensureProtectedDirectory(path: string): Promise<void> {
  await ensureDirectory(path);
  await chmod(path, 0o700);
}

async function ensureDirectory(path: string): Promise<void> {
  const status = await lstat(path).catch(async (error: unknown) => {
    if (!isMissingPathError(error)) throw error;
    await mkdir(path, { mode: 0o700 });
    return lstat(path);
  });
  if (status.isSymbolicLink()) throw new Error("Daemon log path must not contain symbolic links");
  if (!status.isDirectory()) throw new Error("Daemon log path must contain only directories");
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
