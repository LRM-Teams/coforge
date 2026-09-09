import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { encodeReminderFireRequest, encodeReminderSync } from "@coforge/protocol";
import type { ReminderReceipt, ReminderReceiptStore } from "../agent-reminder/reminder-scheduler";

const SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KEYS = new Set([
  "workspaceId",
  "computerId",
  "agentId",
  "reminderId",
  "version",
  "job",
  "requestId",
  "firedAtClient",
  "attempt",
  "deadline",
  "nextAt",
  "serverResult",
  "serverFired",
  "serverCatchup",
  "wakeAccepted",
  "consumed",
  "terminal",
]);

function receipt(value: unknown, workspaceId: string, computerId: string, agentId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("reminder receipts are corrupt");
  const item = value as Record<string, unknown>;
  const job = item.job as Record<string, unknown> | undefined;
  if (
    Object.keys(item).some((key) => !KEYS.has(key)) ||
    item.workspaceId !== workspaceId ||
    item.agentId !== agentId ||
    item.computerId !== computerId ||
    typeof item.reminderId !== "string" ||
    !Number.isSafeInteger(item.version) ||
    (item.version as number) <= 0 ||
    typeof item.requestId !== "string" ||
    typeof item.firedAtClient !== "string" ||
    !Number.isSafeInteger(item.attempt) ||
    (item.attempt as number) < 0 ||
    typeof item.deadline !== "number" ||
    !Number.isFinite(item.deadline) ||
    typeof item.nextAt !== "number" ||
    !Number.isFinite(item.nextAt) ||
    typeof item.wakeAccepted !== "boolean" ||
    typeof item.consumed !== "boolean" ||
    typeof item.terminal !== "boolean" ||
    !job ||
    job.ownerAgentId !== agentId ||
    job.reminderId !== item.reminderId ||
    job.version !== item.version ||
    (item.serverResult !== undefined &&
      !["accepted", "premature", "obsolete"].includes(item.serverResult as string)) ||
    (item.serverFired !== undefined && typeof item.serverFired !== "boolean") ||
    (item.serverCatchup !== undefined && typeof item.serverCatchup !== "boolean") ||
    (item.wakeAccepted === true && item.terminal !== true) ||
    (item.consumed === true && item.terminal !== true)
  )
    throw new Error("reminder receipts are corrupt");
  const validated = structuredClone(value) as ReminderReceipt;
  try {
    encodeReminderFireRequest({
      protocolMajor: 1,
      requestId: validated.requestId,
      workspaceId,
      computerId,
      agentId,
      reminderId: validated.reminderId,
      version: validated.version,
      firedAtClient: validated.firedAtClient,
    });
    encodeReminderSync({
      protocolMajor: 1,
      requestId: validated.requestId,
      workspaceId,
      computerId,
      agentId,
      operation: "snapshot",
      jobs: [validated.job],
      messageType: "coforge.rpc.v1.ReminderSync",
    });
  } catch {
    throw new Error("reminder receipts are corrupt");
  }
  return validated;
}

export class FileReminderReceiptStore implements ReminderReceiptStore {
  constructor(
    private readonly stateDirectory: string,
    private readonly workspaceId: string,
    private readonly computerId: string,
  ) {
    if (!stateDirectory || !SAFE.test(workspaceId) || !SAFE.test(computerId))
      throw new Error("invalid reminder receipt scope");
  }
  #path(agentId: string) {
    if (!SAFE.test(agentId)) throw new Error("invalid reminder receipt Agent scope");
    return join(
      this.stateDirectory,
      "reminder-receipts",
      this.workspaceId,
      agentId,
      "receipts.json",
    );
  }
  async read(agentId: string): Promise<ReminderReceipt[]> {
    const path = this.#path(agentId);
    if (!(await Bun.file(path).exists())) return [];
    const value = JSON.parse(await Bun.file(path).text()) as {
      version?: unknown;
      receipts?: unknown;
    };
    if (value.version !== 1 || !Array.isArray(value.receipts))
      throw new Error("reminder receipts are corrupt");
    const receipts = value.receipts.map((item) =>
      receipt(item, this.workspaceId, this.computerId, agentId),
    );
    if (
      new Set(receipts.map((item) => `${item.reminderId}:${item.version}`)).size !== receipts.length
    )
      throw new Error("reminder receipts are corrupt");
    return receipts;
  }
  async write(agentId: string, receipts: readonly ReminderReceipt[]): Promise<void> {
    const path = this.#path(agentId);
    const validated = receipts.map((item) =>
      receipt(item, this.workspaceId, this.computerId, agentId),
    );
    if (
      new Set(validated.map((item) => `${item.reminderId}:${item.version}`)).size !==
      validated.length
    )
      throw new Error("reminder receipts are corrupt");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, receipts: validated }) + "\n", {
      mode: 0o600,
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
  }
}
