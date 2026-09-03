import {
  configure,
  dispose,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
  type Logger,
} from "@logtape/logtape";
import { DEFAULT_REDACT_FIELDS, redactByField } from "@logtape/redaction";

const DAEMON_CATEGORY = ["coforge", "daemon"];

export async function configureDaemonLogger(input: {
  version: string;
  pid?: number;
}): Promise<{ logger: Logger; close(): Promise<void> }> {
  const sink = redactByField(
    getConsoleSink({
      formatter: getJsonLinesFormatter({ properties: "flatten" }),
      levelMap: {
        trace: "error",
        debug: "error",
        info: "error",
        warning: "error",
        error: "error",
        fatal: "error",
      },
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
