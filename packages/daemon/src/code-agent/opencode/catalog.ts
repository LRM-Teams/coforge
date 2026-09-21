import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  type CodeAgentModelMetadata,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { diagnosticErrorCode } from "../../platform/diagnostic-error-code";
import { agentEnvironment } from "../environment";

const logger = getLogger(["coforge", "daemon", "code-agent", "opencode"]);

/**
 * OpenCode's reasoning-effort names and their order, copied from Raft's `opencodeVariantOrder`
 * (`server/pkg/agent/models.go:790`). A model's `variants` map keyed by these names is what makes
 * its thinking selector: the value is what `opencode run --variant` accepts.
 */
const VARIANT_ORDER: Readonly<Record<string, number>> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

/** A JSON model-metadata block never runs longer than this; a block that does is malformed and is
 * dropped rather than swallowing every later model row. */
const MAX_METADATA_LINES = 400;

/**
 * Parses `opencode models --verbose` output: one `provider/model` row per model, optionally
 * followed by a pretty-printed JSON object describing it. The id is kept **verbatim** — it is
 * exactly what `opencode run --model` accepts — and each enabled, non-disabled `variants` entry
 * becomes a reasoning level (`--variant`), ordered by OpenCode's own effort order. Non-verbose
 * output (just the id rows) yields the same models with no reasoning levels.
 *
 * Raft's `parseOpenCodeModels` (`models.go:687`) is the reference: it too keeps the id verbatim
 * and projects variants into the thinking picker.
 */
export function parseOpenCodeModelList(output: string): CodeAgentModelMetadata[] {
  const models: CodeAgentModelMetadata[] = [];
  let pending: CodeAgentModelMetadata | undefined;
  let metadata: string[] = [];

  const annotate = () => {
    if (pending && metadata.length > 0 && metadata.length <= MAX_METADATA_LINES) {
      try {
        applyModelMetadata(pending, JSON.parse(metadata.join("\n")));
      } catch {
        // A block we cannot parse leaves the model as the id row alone, which is still usable.
      }
    }
    metadata = [];
  };

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (metadata.length > 0) {
      metadata.push(line);
      try {
        JSON.parse(metadata.join("\n"));
        annotate();
      } catch {
        // Not complete yet; keep accumulating.
      }
      continue;
    }
    if (!line) continue;
    if (line.startsWith("{")) {
      metadata.push(line);
      continue;
    }
    // A model row: one whitespace-free `provider/model` token.
    if (/\s/.test(line) || !line.includes("/")) continue;
    annotate();
    pending = {
      id: line,
      displayName: line,
      description: "",
      modelProvider: line.slice(0, line.indexOf("/")),
      reasoningEfforts: [],
      // OpenCode documents no default variant; the picker offers its own "Provider default".
      defaultReasoning: "",
      recommended: false,
    };
    models.push(pending);
  }
  annotate();
  return models;
}

type OpenCodeModelMetadata = {
  name?: unknown;
  capabilities?: { reasoning?: unknown };
  variants?: Record<string, unknown>;
};

/** Applies one model's JSON metadata: its display name and its variant-derived reasoning levels. */
function applyModelMetadata(model: CodeAgentModelMetadata, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const metadata = value as OpenCodeModelMetadata;
  if (typeof metadata.name === "string" && metadata.name.trim())
    model.displayName = metadata.name.trim();
  // Raft's gate (`models.go:805`): the model advertises reasoning (`capabilities.reasoning`) or
  // carries a variant that looks like a reasoning effort; only then do its variants become levels.
  const variants = metadata.variants;
  const reasoning = metadata.capabilities?.reasoning === true;
  if (!reasoning && !variantsLookLikeReasoning(variants)) return;
  const levels = reasoningLevels(variants);
  if (levels.length > 0) model.reasoningEfforts = levels;
}

/** Raft's `openCodeVariantsLookReasoning` (`models.go:815`): a known effort name, or an entry that
 * carries `reasoningEffort`/`thinking`, is what makes a variant map a reasoning picker. */
function variantsLookLikeReasoning(variants: unknown): boolean {
  if (!variants || typeof variants !== "object" || Array.isArray(variants)) return false;
  return Object.entries(variants as Record<string, unknown>).some(([name, variant]) => {
    if (VARIANT_ORDER[name] !== undefined) return true;
    if (!variant || typeof variant !== "object" || Array.isArray(variant)) return false;
    const entry = variant as Record<string, unknown>;
    return (
      (typeof entry.reasoningEffort === "string" && entry.reasoningEffort.length > 0) ||
      entry.thinking !== undefined
    );
  });
}

/**
 * The reasoning levels a model advertises: its enabled variants, ordered by OpenCode's own effort
 * order (`none < minimal < low < medium < high < xhigh < max`, Raft's `opencodeVariantOrder`).
 * Raft's `openCodeThinkingLevelsFromVariants` (`models.go:827`) is the reference.
 */
function reasoningLevels(variants: unknown): string[] {
  if (!variants || typeof variants !== "object" || Array.isArray(variants)) return [];
  const levels = Object.entries(variants as Record<string, unknown>)
    .filter(([name, variant]) => {
      if (!name || name.trim() !== name) return false;
      if (!variant || typeof variant !== "object" || Array.isArray(variant)) return false;
      const entry = variant as Record<string, unknown>;
      return entry.disabled !== true;
    })
    .map(([name]) => name);
  return levels.sort((left, right) => {
    const leftKnown = VARIANT_ORDER[left];
    const rightKnown = VARIANT_ORDER[right];
    if (leftKnown !== undefined && rightKnown !== undefined) return leftKnown - rightKnown;
    if (leftKnown !== undefined) return -1;
    if (rightKnown !== undefined) return 1;
    return left.localeCompare(right);
  });
}

/**
 * Runs `opencode models --verbose` (Raft's own 15 s budget: a recent OpenCode syncs its hosted
 * model catalog over the network here) and parses the catalog. An empty verbose result retries
 * the plain command, which omits per-model metadata but still lists the ids. Any failure - missing
 * CLI, non-zero exit, timeout, unparseable output - means no catalog, never a thrown error.
 */
export async function discoverOpenCodeCatalog(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs = 15_000,
): Promise<CodeAgentModelCatalog | undefined> {
  const verbose = await runOpenCodeModels([...command, "--verbose"], cwd, environment, timeoutMs);
  const models = verbose ? parseOpenCodeModelList(verbose) : [];
  const resolved = models.length > 0 ? models : await runPlainModels(command, cwd, environment);
  return resolved.length > 0
    ? { provider: RUNTIME_PROVIDER.OPENCODE, models: resolved }
    : undefined;
}

async function runPlainModels(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<CodeAgentModelMetadata[]> {
  const plain = await runOpenCodeModels(command, cwd, environment, 5_000);
  return plain ? parseOpenCodeModelList(plain) : [];
}

async function runOpenCodeModels(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): Promise<string | undefined> {
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
          throw new Error("OpenCode model catalog discovery timed out");
        }),
      ]);
      // A stale config entry can make `opencode models` exit non-zero while still listing the
      // resolvable catalog (Raft reads the output regardless of exit code, `models.go:674-680`).
      if (!output.trim()) {
        logger.warning("OpenCode model catalog unavailable", {
          event: "opencode.catalog.unavailable",
          exit_code: exitCode,
        });
        return undefined;
      }
      return output;
    } finally {
      child.kill();
    }
  } catch (error) {
    logger.warning("OpenCode model catalog discovery failed", {
      event: "opencode.catalog.unavailable",
      error_code: diagnosticErrorCode(error),
    });
    return undefined;
  }
}
