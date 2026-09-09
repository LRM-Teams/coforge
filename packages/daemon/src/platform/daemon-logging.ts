import { AsyncLocalStorage } from "node:async_hooks";
import { getRotatingFileSink } from "@logtape/file";
import { configure, getJsonLinesFormatter } from "@logtape/logtape";
import { DEFAULT_REDACT_FIELDS, redactByField } from "@logtape/redaction";
import { prepareDaemonLogFile } from "./daemon-log-file";

/** Shared sink configuration, called once by each Daemon-role entrypoint. */
export async function configureDaemonLogging(stateDirectory: string): Promise<void> {
  const logPath = await prepareDaemonLogFile(stateDirectory);
  await configure({
    reset: true,
    sinks: {
      daemon: redactByField(
        getRotatingFileSink(logPath, {
          maxSize: 10 * 1024 * 1024,
          maxFiles: 5,
          bufferSize: 8192,
          flushInterval: 1000,
          formatter: getJsonLinesFormatter({ properties: "flatten" }),
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
      ),
    },
    loggers: [
      { category: ["coforge", "daemon"], lowestLevel: "info", sinks: ["daemon"] },
      { category: ["logtape", "meta"], lowestLevel: "error" },
    ],
    contextLocalStorage: new AsyncLocalStorage<Record<string, unknown>>(),
  });
}
