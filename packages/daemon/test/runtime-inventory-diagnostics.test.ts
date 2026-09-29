import { expect, test } from "bun:test";
import { discoverCodexCatalog } from "#src/code-agent/runtime-inventory";
import { CATALOG_DISCOVERY_BUDGET_MS } from "./catalog-discovery-budget";
import { captureDaemonLogs } from "./log-capture";

/** These tests cover the Codex catalog's diagnostics, so they call its discovery directly. The
 * whole-inventory pass would add Pi's in-process catalog discovery, which is not under test and,
 * against a developer's real HOME, runs for seconds: it was most of each test's time. The
 * inventory's use of the Codex catalog is covered in runtime-inventory.test.ts. */
async function captureDiscovery(mode: string) {
  const { records } = await captureDaemonLogs(async () => {
    const catalog = await discoverCodexCatalog(
      [process.execPath, new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname, mode],
      process.cwd(),
      { PATH: Bun.env.PATH },
    );
    expect(catalog).toBeUndefined();
  });
  return records;
}

test(
  "catalog failure identifies the request and provider error without logging secrets",
  async () => {
    const records = await captureDiscovery("catalog-error");
    const failure = records.find(
      (record) => record.properties.event === "code_agent_catalog:discovery_failed",
    );
    const discoveryId = failure?.properties.discovery_id;
    expect(failure?.properties).toMatchObject({
      provider: "codex",
      stage: "model/list",
      error_message: "code agent request failed",
      provider_error_code: -32001,
      elapsed_ms: expect.any(Number),
      discovery_id: expect.any(String),
    });
    expect(JSON.stringify(records)).not.toContain("fixture-private-token");
    const cleanup = records.find((record) =>
      ["code_agent_catalog:cleanup_completed", "code_agent_catalog:cleanup_failed"].includes(
        String(record.properties.event),
      ),
    );
    expect(cleanup?.properties.discovery_id).toBe(discoveryId);
    expect(cleanup?.properties.provider).toBe("codex");
    if (cleanup?.properties.event === "code_agent_catalog:cleanup_failed") {
      expect(cleanup.properties).toMatchObject({
        outcome: "failed",
        error_message: "code agent process tree did not exit",
      });
    } else {
      expect(cleanup?.properties.outcome).toBe("ok");
    }
  },
  CATALOG_DISCOVERY_BUDGET_MS,
);

test(
  "catalog timeout records its stage, duration, and cleanup completion",
  async () => {
    const records = await captureDiscovery("catalog-timeout");
    const failure = records.find(
      (record) => record.properties.event === "code_agent_catalog:discovery_failed",
    );
    expect(failure?.properties).toMatchObject({
      stage: "model/list",
      error_message: "model catalog discovery timed out after 5000 ms",
    });
    expect(failure?.properties.elapsed_ms).toBeGreaterThanOrEqual(5000);
    expect(
      records.some((record) => record.properties.event === "code_agent_catalog:cleanup_completed"),
    ).toBe(true);
  },
  CATALOG_DISCOVERY_BUDGET_MS,
);

test(
  "catalog process exit records the exit code and pending discovery stage",
  async () => {
    const records = await captureDiscovery("catalog-exit");
    const exit = records.find((record) => record.properties.event === "code_agent.process.exited");
    expect(exit?.properties).toMatchObject({
      exit_code: 23,
      expected_exit: false,
      pid: expect.any(Number),
    });
    const failure = records.find(
      (record) => record.properties.event === "code_agent_catalog:discovery_failed",
    );
    expect(failure?.properties).toMatchObject({
      stage: "model/list",
      error_message: "code agent process exited unexpectedly",
    });
  },
  CATALOG_DISCOVERY_BUDGET_MS,
);

test(
  "invalid catalog data is diagnosed without persisting the provider payload",
  async () => {
    const records = await captureDiscovery("catalog-invalid");
    const failure = records.find(
      (record) => record.properties.event === "code_agent_catalog:discovery_failed",
    );
    expect(failure?.properties).toMatchObject({
      stage: "decode_catalog",
      error_message: "Codex model catalog is unavailable",
    });
    expect(JSON.stringify(records)).not.toContain("fixture-private-payload");
  },
  CATALOG_DISCOVERY_BUDGET_MS,
);
