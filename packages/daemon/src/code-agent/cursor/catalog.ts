import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  type CodeAgentModelMetadata,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { diagnosticErrorCode } from "../../platform/diagnostic-error-code";
import { agentEnvironment } from "../environment";

const logger = getLogger(["coforge", "daemon", "code-agent", "cursor"]);

// eslint-disable-next-line no-control-regex -- Strips ANSI escapes from `cursor-agent models`.
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;
const TRAILING_MARKER_PATTERN = /\s*\((default|current|current,\s*default)\)\s*$/i;
const SKIPPED_LINE_PREFIXES = ["Tip:", "No models available", "Failed to load models:"];

/**
 * Parses `cursor-agent models` plain-text output: one `id - Label` line per model, an optional
 * trailing ` (default)` / ` (current)` / ` (current, default)` marker, an `Available models`
 * header, blank lines, `Tip:` lines, and unavailable/failure lines to skip. Effort is baked into
 * Cursor's model ids - there is no separate reasoning control to report.
 */
export function parseCursorModelList(output: string): CodeAgentModelMetadata[] {
  const models: CodeAgentModelMetadata[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replaceAll(ANSI_ESCAPE_PATTERN, "").trim();
    if (!line || line === "Available models") continue;
    if (SKIPPED_LINE_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const id = line.slice(0, separator).trim();
    let label = line.slice(separator + 3).trim();
    if (!id || !label) continue;
    const marker = TRAILING_MARKER_PATTERN.exec(label);
    const isDefault = marker !== null && marker[1]!.toLowerCase().includes("default");
    if (marker) label = label.slice(0, marker.index).trim();
    if (!label) continue;
    models.push({
      id,
      displayName: label,
      description: "",
      modelProvider: "",
      reasoningEfforts: [],
      defaultReasoning: "",
      recommended: isDefault,
    });
  }
  return models;
}

/** Runs `cursor-agent models` (default 5 s timeout) and parses its catalog. A non-zero exit,
 * a timeout, or an empty parsed list all mean no catalog - never a thrown error, matching how
 * every other cacheable catalog probe reports "unavailable" to `runtime-inventory.ts`. */
export async function discoverCursorCatalog(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs = 5_000,
): Promise<CodeAgentModelCatalog | undefined> {
  try {
    const spawnEnvironment = {
      ...agentEnvironment(undefined, environment),
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    };
    const child = Bun.spawn({
      cmd: [...command],
      cwd,
      env: spawnEnvironment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    try {
      const [output, exitCode] = await Promise.race([
        Promise.all([new Response(child.stdout).text(), child.exited]),
        Bun.sleep(timeoutMs).then((): [string, number] => {
          throw new Error("Cursor model catalog discovery timed out");
        }),
      ]);
      if (exitCode !== 0) {
        logger.warning("Cursor model catalog unavailable", {
          event: "cursor.catalog.unavailable",
          exit_code: exitCode,
        });
        return undefined;
      }
      const models = parseCursorModelList(output);
      return models.length ? { provider: RUNTIME_PROVIDER.CURSOR, models } : undefined;
    } finally {
      child.kill();
    }
  } catch (error) {
    logger.warning("Cursor model catalog discovery failed", {
      event: "cursor.catalog.unavailable",
      error_code: diagnosticErrorCode(error),
    });
    return undefined;
  }
}
