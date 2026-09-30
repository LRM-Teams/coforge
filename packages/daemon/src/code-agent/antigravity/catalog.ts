import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  type CodeAgentModelMetadata,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { diagnosticErrorCode } from "#src/platform/diagnostic-error-code";
import { runCatalogCommand } from "#src/code-agent/catalog-command";
import { withoutSshSessionVariables } from "./ssh-environment";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.ANTIGRAVITY]);

/**
 * Parses `agy models` output: one model per line as `<slug><TAB><label>` (observed on 1.2.13; the
 * docs show no format). A line without a tab is not a model - a local wrapper may print a banner
 * ahead of the list - and the CLI's own `Fetching available models...` progress line goes to
 * stderr. The command marks no default model,
 * so nothing is recommended, and effort is part of the slug (`gemini-3.1-pro-high`), so there is no
 * separate reasoning control to offer.
 */
export function parseAntigravityModelList(output: string): CodeAgentModelMetadata[] {
  const models: CodeAgentModelMetadata[] = [];
  for (const line of Bun.stripANSI(output).split(/\r?\n/)) {
    const separator = line.indexOf("\t");
    if (separator === -1) continue;
    const id = line.slice(0, separator).trim();
    if (!id) continue;
    models.push({
      id,
      displayName: line.slice(separator + 1).trim() || id,
      description: "",
      modelProvider: "",
      reasoningEfforts: [],
      defaultReasoning: "",
      recommended: false,
    });
  }
  return models;
}

/** How long `agy models` may run. It fetches the model list over the network each time
 * ("Fetching available models..."), which took 4.3-4.9 s on agy 1.2.13, too close to the usual
 * 5 s catalog wait. */
export const ANTIGRAVITY_MODELS_TIMEOUT_MS = 15_000;

/** Runs `agy models` and parses its catalog. A non-zero exit, a timeout, or
 * an empty parsed list all mean no catalog - never a thrown error, matching how every other
 * cacheable catalog probe reports "unavailable" to `runtime-inventory.ts`. */
export async function discoverAntigravityCatalog(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs = ANTIGRAVITY_MODELS_TIMEOUT_MS,
): Promise<CodeAgentModelCatalog | undefined> {
  try {
    const { output, exitCode } = await runCatalogCommand(
      command,
      cwd,
      withoutSshSessionVariables(environment),
      timeoutMs,
    );
    if (exitCode !== 0) {
      logger.warning("Antigravity model catalog unavailable", {
        event: "antigravity.catalog.unavailable",
        exit_code: exitCode,
      });
      return undefined;
    }
    const models = parseAntigravityModelList(output);
    return models.length ? { provider: RUNTIME_PROVIDER.ANTIGRAVITY, models } : undefined;
  } catch (error) {
    logger.warning("Antigravity model catalog discovery failed", {
      event: "antigravity.catalog.unavailable",
      error_code: diagnosticErrorCode(error),
    });
    return undefined;
  }
}
