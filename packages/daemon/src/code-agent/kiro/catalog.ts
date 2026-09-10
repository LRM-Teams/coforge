import type { CodeAgentModelCatalog } from "@coforge/protocol";
import { getLogger } from "@logtape/logtape";
import { agentEnvironment } from "../environment";
import { bounded, KiroConnection, record } from "./connection";

const logger = getLogger(["coforge", "daemon", "code-agent", "kiro"]);

export async function discoverKiroCatalog(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  configTimeoutMs = 30_000,
): Promise<CodeAgentModelCatalog | undefined> {
  let transport: KiroConnection | undefined;
  try {
    transport = new KiroConnection(command, cwd, agentEnvironment(undefined, environment));
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
      provider: "kiro",
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
  } catch {
    logger.warning("Kiro v3 model discovery unavailable; verify CLI installation and login", {
      event: "kiro.catalog.unavailable",
    });
    return undefined;
  } finally {
    await transport?.dispose();
  }
}
