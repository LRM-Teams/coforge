import { readFile } from "node:fs/promises";
import { computerLogPath } from "./computer-logger";

export type ComputerLogsOptions = {
  dataDirectory: string;
  write: (line: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
};

/** Print existing Computer logs, then follow the active file until interrupted. */
export async function followComputerLogs(input: ComputerLogsOptions): Promise<void> {
  const path = computerLogPath(input.dataDirectory);
  const sleep = input.sleep ?? Bun.sleep;
  const signal = input.signal ?? createInterruptSignal();
  let offset = 0;

  for (const suffix of [".5", ".4", ".3", ".2", ".1", ""] as const) {
    const content = await readIfPresent(`${path}${suffix}`);
    if (content) writeLines(content, input.write);
  }
  offset = (await readIfPresent(path))?.length ?? 0;

  while (!signal.aborted) {
    const content = await readIfPresent(path);
    if (content === null) {
      offset = 0;
    } else if (content.length < offset) {
      offset = 0;
      writeLines(content, input.write);
      offset = content.length;
    } else if (content.length > offset) {
      writeLines(content.slice(offset), input.write);
      offset = content.length;
    }
    await sleep(250);
  }
}

function writeLines(content: string, write: (line: string) => void): void {
  for (const line of content.split("\n")) {
    if (line.length > 0) write(line);
  }
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function createInterruptSignal(): AbortSignal {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  return controller.signal;
}
