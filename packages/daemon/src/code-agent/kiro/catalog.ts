import { RUNTIME_PROVIDER, type CodeAgentModelCatalog } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { agentEnvironment } from "../environment";
import { diagnosticErrorCode } from "../../platform/diagnostic-error-code";
import { bounded, KiroConnection, record } from "./connection";

const logger = getLogger(["coforge", "daemon", "code-agent", "kiro"]);

export async function discoverKiroCatalog(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  configTimeoutMs = 30_000,
): Promise<CodeAgentModelCatalog | undefined> {
  let transport: KiroConnection | undefined;
  // A CLI argument error (e.g. an unsupported flag) is not a secret; still, only the first
  // scrubbed, bounded line is kept, never the full stderr stream.
  let stderrHint: string | undefined;
  try {
    transport = new KiroConnection(command, cwd, agentEnvironment(undefined, environment));
    transport.process.onStderr((line) => {
      if (stderrHint === undefined && line.trim()) stderrHint = scrubStderrHint(line);
    });
    await transport.initialize();
    const session = await bounded(
      transport.connection.agent.request("session/new", { cwd, mcpServers: [] }),
    );
    const config = await transport.waitForConfig(
      session.sessionId,
      session.configOptions ?? [],
      "model",
      configTimeoutMs,
    );
    const option = config.find((option) => option.category === "model");
    if (option?.type !== "select") throw new Error("Kiro model catalog unavailable");
    const entries = option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
    return {
      provider: RUNTIME_PROVIDER.KIRO,
      models: entries.map((entry) => {
        const metadata = record(entry._meta?.kiro);
        const reasoningEfforts = Array.isArray(metadata?.effortLevels)
          ? metadata.effortLevels.filter((value): value is string => typeof value === "string")
          : [];
        return {
          id: entry.value,
          displayName: entry.name,
          description: entry.description ?? "",
          modelProvider: "",
          reasoningEfforts,
          defaultReasoning:
            typeof metadata?.defaultEffortLevel === "string" &&
            reasoningEfforts.includes(metadata.defaultEffortLevel)
              ? metadata.defaultEffortLevel
              : "",
          recommended: entry.value === option.currentValue,
        };
      }),
    };
  } catch (error) {
    logger.warning("Kiro v3 model discovery unavailable", {
      event: "kiro.catalog.unavailable",
      error_code: diagnosticErrorCode(error),
      ...(stderrHint ? { stderr_hint: stderrHint } : {}),
    });
    return undefined;
  } finally {
    await transport?.dispose();
  }
}

/** A short, single-line, bounded excerpt of a CLI diagnostic; redacts anything that looks like a
 * token or credential before it ever reaches a log. */
function scrubStderrHint(line: string): string {
  return line
    .trim()
    .replace(/(?:sk|pk|api|token|key|secret)[_-]?[A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 200);
}
