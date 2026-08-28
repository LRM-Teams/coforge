import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  configure,
  dispose,
  getJsonLinesFormatter,
  getLogger,
  type Logger,
} from "@logtape/logtape";
import { getRotatingFileSink } from "@logtape/file";
import { redactByField } from "@logtape/redaction";

const COMPUTER_CATEGORY = ["coforge", "computer"];
const LOG_FILE = "computer.jsonl";

export async function configureComputerLogger(input: {
  dataDirectory: string;
  version: string;
  pid?: number;
}): Promise<{ logger: Logger; close(): Promise<void> }> {
  const directory = join(input.dataDirectory, "logs", "computer");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const sink = redactByField(
    getRotatingFileSink(join(directory, LOG_FILE), {
      maxSize: 10 * 1024 * 1024,
      maxFiles: 5,
      bufferSize: 8192,
      flushInterval: 1000,
      formatter: getJsonLinesFormatter({ properties: "nest:properties" }),
    }),
  );
  await configure({
    reset: true,
    sinks: { computer: sink },
    loggers: [
      { category: COMPUTER_CATEGORY, lowestLevel: "info", sinks: ["computer"] },
      { category: ["logtape", "meta"], lowestLevel: "error" },
    ],
  });
  const logger = getLogger(COMPUTER_CATEGORY).with({
    service: "coforge-computer",
    version: input.version,
    process_role: "computer",
    pid: input.pid ?? process.pid,
  });
  return { logger, close: dispose };
}

export function computerLogPath(dataDirectory: string): string {
  return join(dataDirectory, "logs", "computer", LOG_FILE);
}
