import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join, parse, relative, resolve, sep } from "node:path";
import {
  configure,
  dispose,
  getJsonLinesFormatter,
  getLogger,
  type Logger,
} from "@logtape/logtape";
import { getRotatingFileSink } from "@logtape/file";
import { DEFAULT_REDACT_FIELDS, redactByField } from "@logtape/redaction";

const DAEMON_CATEGORY = ["coforge", "daemon"];
const LOG_FILE = "daemon.jsonl";

export async function configureDaemonLogger(input: {
  dataDirectory: string;
  version: string;
  pid?: number;
}): Promise<{ logger: Logger; close(): Promise<void> }> {
  const directory = join(input.dataDirectory, "logs", "daemon");
  const path = daemonLogPath(input.dataDirectory);
  await ensureDirectoryTree(input.dataDirectory);
  await ensureProtectedDirectory(join(input.dataDirectory, "logs"));
  await ensureProtectedDirectory(directory);
  for (let index = 0; index <= 5; index++) {
    const candidate = index === 0 ? path : `${path}.${index}`;
    const status = await lstat(candidate).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    });
    if (status?.isSymbolicLink())
      throw new Error("Daemon log path must not contain symbolic links");
    if (status && !status.isFile()) throw new Error("Daemon log files must be regular files");
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
  const sink = redactByField(
    getRotatingFileSink(path, {
      maxSize: 10 * 1024 * 1024,
      maxFiles: 5,
      bufferSize: 8192,
      flushInterval: 1000,
      formatter: getJsonLinesFormatter({ properties: "nest:properties" }),
    }),
    {
      fieldPatterns: [
        ...DEFAULT_REDACT_FIELDS,
        /^authorization$/i,
        /^body$/i,
        /^cookie$/i,
        /^message_body$/i,
        /^prompt$/i,
        /^secret$/i,
      ],
    },
  );
  await chmod(path, 0o600);
  await configure({
    reset: true,
    sinks: { daemon: sink },
    loggers: [
      { category: DAEMON_CATEGORY, lowestLevel: "info", sinks: ["daemon"] },
      { category: ["logtape", "meta"], lowestLevel: "error" },
    ],
  });
  return {
    logger: getLogger(DAEMON_CATEGORY).with({
      service: "coforge-daemon",
      version: input.version,
      process_role: "daemon",
      pid: input.pid ?? process.pid,
    }),
    close: dispose,
  };
}

export function daemonLogPath(dataDirectory: string): string {
  return join(dataDirectory, "logs", "daemon", LOG_FILE);
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
