import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computerUpgradeResultPath,
  readComputerUpgradeReceipt,
  sweepComputerUpgradeReceipts,
} from "../src/platform/computer-upgrade-receipts";

async function home() {
  return await mkdtemp(join(realpathSync(tmpdir()), "coforge-upgrade-receipt-"));
}

async function writeReceipt(homeDirectory: string, requestId: string, value: unknown) {
  await Bun.write(computerUpgradeResultPath(requestId, homeDirectory), JSON.stringify(value));
}

test("a pending operation has no receipt until its job writes one", async () => {
  const homeDirectory = await home();
  try {
    expect(await readComputerUpgradeReceipt("absent", { homeDirectory })).toBeUndefined();
    await writeReceipt(homeDirectory, "request-a", {
      schema_version: 1,
      request_id: "request-a",
      operation: "upgrade",
      status: "succeeded",
      version: "0.1.0-dev.29",
    });
    expect(await readComputerUpgradeReceipt("request-a", { homeDirectory })).toMatchObject({
      requestId: "request-a",
      status: "succeeded",
      version: "0.1.0-dev.29",
    });
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("a receipt that names another operation, or no known status, is not evidence", async () => {
  const homeDirectory = await home();
  try {
    await writeReceipt(homeDirectory, "request-a", {
      schema_version: 1,
      request_id: "someone-else",
      status: "succeeded",
    });
    expect(await readComputerUpgradeReceipt("request-a", { homeDirectory })).toBeUndefined();
    await writeReceipt(homeDirectory, "request-b", { schema_version: 1, status: "running" });
    expect(await readComputerUpgradeReceipt("request-b", { homeDirectory })).toBeUndefined();
    await Bun.write(computerUpgradeResultPath("request-c", homeDirectory), "{ not json");
    expect(await readComputerUpgradeReceipt("request-c", { homeDirectory })).toBeUndefined();
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("the sweep settles only the pending operations whose job already finished", async () => {
  const homeDirectory = await home();
  try {
    await writeReceipt(homeDirectory, "done", {
      schema_version: 1,
      request_id: "done",
      status: "failed",
      error: "candidate failed",
    });
    const settled: { workspaceId: string; requestId: string; status: string }[] = [];
    const resolved = await sweepComputerUpgradeReceipts(
      [
        { workspaceId: "a", requestId: "done" },
        { workspaceId: "a", requestId: "still-running" },
      ],
      async (workspaceId, requestId, receipt) => {
        settled.push({ workspaceId, requestId, status: receipt.status });
      },
      { homeDirectory },
    );

    expect(resolved).toBe(1);
    expect(settled).toEqual([{ workspaceId: "a", requestId: "done", status: "failed" }]);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});
