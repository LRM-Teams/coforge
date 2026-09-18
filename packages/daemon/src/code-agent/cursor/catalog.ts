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
const TRAILING_MARKERS_PATTERN = /\s+\(([^)]+)\)$/;
const MODEL_LINE_PATTERN = /^(\S+)(?:\s+-\s+(.+))?$/;
const SKIPPED_LINE_PATTERNS = [
  /^available models$/i,
  /^tip:/i,
  /^no models available/i,
  /^failed to load models:/i,
];

/**
 * Parses `cursor-agent models` plain-text output. Each model line is `<id>` optionally followed by
 * ` - <label>` (the label falls back to the id). A trailing parenthesised marker list is removed
 * only when every marker is `current` or `default`; the `default` marker makes that model the
 * recommended one. The header, blank lines, `Tip:` lines, and unavailable/failure lines are
 * skipped. Effort is baked into Cursor's model ids - there is no separate reasoning control.
 */
export function parseCursorModelList(output: string): CodeAgentModelMetadata[] {
  const models: CodeAgentModelMetadata[] = [];
  for (const rawLine of output.replaceAll(ANSI_ESCAPE_PATTERN, "").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || SKIPPED_LINE_PATTERNS.some((pattern) => pattern.test(line))) continue;
    const markerMatch = TRAILING_MARKERS_PATTERN.exec(line);
    const markers = markerMatch?.[1]?.split(",").map((part) => part.trim().toLowerCase()) ?? [];
    const onlyKnownMarkers =
      markers.length > 0 && markers.every((part) => part === "current" || part === "default");
    if (onlyKnownMarkers) line = line.slice(0, markerMatch!.index).trim();
    const match = MODEL_LINE_PATTERN.exec(line);
    const id = match?.[1]?.trim();
    if (!id || id.startsWith("-")) continue;
    models.push({
      id,
      displayName: match?.[2]?.trim() || id,
      description: "",
      modelProvider: "",
      reasoningEfforts: [],
      defaultReasoning: "",
      recommended: markers.includes("default"),
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
