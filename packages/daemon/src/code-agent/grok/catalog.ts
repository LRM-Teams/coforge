import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  type CodeAgentModelMetadata,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { diagnosticErrorCode } from "#src/platform/diagnostic-error-code";
import { runCatalogCommand } from "#src/code-agent/catalog-command";

const logger = getLogger(["coforge", "daemon", "code-agent", "grok"]);

// eslint-disable-next-line no-control-regex -- Strips ANSI escapes from `grok models`.
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;
/** `* grok-4.7 (default)` / `- grok-4.7-build-fast`: a bullet, the id, then optional markers. */
const MODEL_LINE_PATTERN = /^([*-])\s+(\S+)(?:\s+\(([^)]*)\))?$/;
const SKIPPED_LINE_PATTERNS = [
  /^you are logged in/i,
  /^available models$/i,
  /^default model:/i,
  /^no models available/i,
  /^failed to load models:/i,
];

/**
 * Parses `grok models` plain-text output. The command prints a login line, `Default model: <id>`,
 * an `Available models:` header and then one bulleted model per line: `*` for the default and `-`
 * for the rest, each followed by the id and an optional parenthesised marker list. A `default`
 * marker marks that model recommended. Markers are the only metadata the command prints, so effort
 * lists stay empty - Grok takes no separate reasoning control here.
 */
export function parseGrokModelList(output: string): CodeAgentModelMetadata[] {
  const models: CodeAgentModelMetadata[] = [];
  for (const rawLine of output.replaceAll(ANSI_ESCAPE_PATTERN, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || SKIPPED_LINE_PATTERNS.some((pattern) => pattern.test(line))) continue;
    const match = MODEL_LINE_PATTERN.exec(line);
    const id = match?.[2]?.trim();
    if (!id) continue;
    const markers = match?.[3]?.split(",").map((part) => part.trim().toLowerCase()) ?? [];
    models.push({
      id,
      displayName: id,
      description: "",
      modelProvider: "",
      reasoningEfforts: [],
      defaultReasoning: "",
      recommended: markers.includes("default"),
    });
  }
  return models;
}

/** Runs `grok models` (default 5 s timeout) and parses its catalog. A non-zero exit, a timeout, or
 * an empty parsed list all mean no catalog - never a thrown error, matching how every other
 * cacheable catalog probe reports "unavailable" to `runtime-inventory.ts`. */
export async function discoverGrokCatalog(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs = 5_000,
): Promise<CodeAgentModelCatalog | undefined> {
  try {
    const { output, exitCode } = await runCatalogCommand(command, cwd, environment, timeoutMs);
    if (exitCode !== 0) {
      logger.warning("Grok model catalog unavailable", {
        event: "grok.catalog.unavailable",
        exit_code: exitCode,
      });
      return undefined;
    }
    const models = parseGrokModelList(output);
    return models.length ? { provider: RUNTIME_PROVIDER.GROK, models } : undefined;
  } catch (error) {
    logger.warning("Grok model catalog discovery failed", {
      event: "grok.catalog.unavailable",
      error_code: diagnosticErrorCode(error),
    });
    return undefined;
  }
}
