import type { Prisma, PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import { readAgentRuntimeCredentialEncryptionKey } from "../agents/agent-runtime-credentials.server";

/**
 * Workspace model configuration (ADR 0052): the model access server-side
 * platform workers draw on — the first server-held model credential in
 * CoForge. Deliberately separate from per-Agent runtime credentials: it never
 * launches a runtime, never owns a Computer, and never serves an Agent turn.
 *
 * Protection discipline is identical to agent runtime credentials: AES-GCM
 * with the same 32-byte key material (`COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY`),
 * key id "v1", and additional data binding ciphertexts to this configuration
 * concept and the Workspace. Consumption is purpose-fenced: only allow-listed
 * worker purposes may resolve a credential, and every model call increments the
 * per-(Workspace, purpose, UTC day) usage counter before it is made — the
 * daily budget gate (ADR 0052-D/E).
 */

const KEY_ID = "v1";
const AAD_SCOPE = "workspace-model-configuration";
const API_KEY_MIN_LENGTH = 8;
const API_KEY_MAX_LENGTH = 4096;

/** Allow-listed worker purposes (ADR 0052-B/G). */
export const WORKSPACE_MODEL_PURPOSES = [
  "group_memory_distillation",
  "group_memory_proposer",
] as const;
export type WorkspaceModelPurpose = (typeof WORKSPACE_MODEL_PURPOSES)[number];

export type WorkspaceModelConfigurationInput = {
  providerId: string;
  baseUrl: string;
  model: string;
  reasoning?: string;
  apiKey?: string;
  dailyBudget?: number;
};

export type WorkspaceModelConfigurationSummary = {
  providerId: string;
  model: string;
  reasoning: string;
  apiKeyHint: string | null;
  dailyBudget: number;
};

export type ResolvedWorkspaceModelCredential = {
  providerId: string;
  baseUrl: string;
  model: string;
  reasoning: string;
  apiKey: string | null;
};

export async function saveWorkspaceModelConfiguration(
  db: PrismaClient,
  principal: { workspaceId: string; userId: string },
  input: WorkspaceModelConfigurationInput,
): Promise<WorkspaceModelConfigurationSummary> {
  await assertWorkspaceManager(db, principal);
  if (!input.providerId.trim())
    throw new AppError("INVALID_INPUT", { errorId: "gm-config-provider" });
  const baseUrl = input.baseUrl.trim();
  if (!/^https?:\/\//.test(baseUrl))
    throw new AppError("INVALID_INPUT", { errorId: "gm-config-url" });
  if (!input.model.trim()) throw new AppError("INVALID_INPUT", { errorId: "gm-config-model" });
  const dailyBudget = input.dailyBudget ?? 50;
  if (!Number.isInteger(dailyBudget) || dailyBudget < 1 || dailyBudget > 10_000)
    throw new AppError("INVALID_INPUT", { errorId: "gm-config-budget" });

  const apiKey = input.apiKey ? validateApiKey(input.apiKey) : null;
  const encrypted = apiKey
    ? await encryptApiKey(principal.workspaceId, input.providerId, apiKey)
    : null;

  await db.workspaceModelConfiguration.upsert({
    where: { workspaceId: principal.workspaceId },
    create: {
      workspaceId: principal.workspaceId,
      providerId: input.providerId.trim(),
      baseUrl,
      model: input.model.trim(),
      reasoning: input.reasoning ?? "",
      apiKey: encrypted as unknown as Prisma.InputJsonValue,
      dailyBudget,
    },
    update: {
      providerId: input.providerId.trim(),
      baseUrl,
      model: input.model.trim(),
      reasoning: input.reasoning ?? "",
      ...(encrypted ? { apiKey: encrypted as unknown as Prisma.InputJsonValue } : {}),
      dailyBudget,
    },
    select: { id: true },
  });
  return workspaceModelConfigurationSummary(db, principal.workspaceId).then((summary) => {
    if (!summary) throw new AppError("INTERNAL_ERROR", { errorId: "gm-config-save" });
    return summary;
  });
}

export async function deleteWorkspaceModelConfiguration(
  db: PrismaClient,
  principal: { workspaceId: string; userId: string },
): Promise<void> {
  await assertWorkspaceManager(db, principal);
  await db.workspaceModelConfiguration.deleteMany({
    where: { workspaceId: principal.workspaceId },
  });
}

export async function workspaceModelConfigurationSummary(
  db: PrismaClient,
  workspaceId: string,
): Promise<WorkspaceModelConfigurationSummary | null> {
  const row = await db.workspaceModelConfiguration.findUnique({
    where: { workspaceId },
    select: {
      providerId: true,
      model: true,
      reasoning: true,
      apiKey: true,
      dailyBudget: true,
    },
  });
  if (!row) return null;
  const apiKey = parseEncryptedApiKey(row.apiKey);
  return {
    providerId: row.providerId,
    model: row.model,
    reasoning: row.reasoning,
    apiKeyHint: apiKey?.hint ?? null,
    dailyBudget: row.dailyBudget,
  };
}

/**
 * Purpose-fenced credential resolution (ADR 0052-B/C): a worker may only
 * resolve a credential for an allow-listed purpose. Returns undefined when the
 * Workspace has no configuration — callers treat that as "distillation
 * paused, retrieval continues" (ADR 0052-E), never as an error.
 */
export async function resolveWorkspaceModelCredential(
  db: PrismaClient,
  workspaceId: string,
  purpose: WorkspaceModelPurpose,
): Promise<ResolvedWorkspaceModelCredential | undefined> {
  if (!WORKSPACE_MODEL_PURPOSES.includes(purpose))
    throw new AppError("ACCESS_DENIED", { errorId: "gm-config-purpose" });
  const row = await db.workspaceModelConfiguration.findUnique({
    where: { workspaceId },
    select: { providerId: true, baseUrl: true, model: true, reasoning: true, apiKey: true },
  });
  if (!row) return undefined;
  const encrypted = parseEncryptedApiKey(row.apiKey);
  const apiKey = encrypted
    ? await decryptApiKey(principalScope(workspaceId, row.providerId), encrypted)
    : null;
  return {
    providerId: row.providerId,
    baseUrl: row.baseUrl,
    model: row.model,
    reasoning: row.reasoning,
    apiKey,
  };
}

export type BudgetDecision =
  | { allowed: true; callsToday: number }
  | { allowed: false; callsToday: number; budget: number };

/**
 * Atomic budget gate (ADR 0052-D): increments today's counter iff it stays
 * within the Workspace's daily budget. Callers must invoke this *before* every
 * model call and skip the call when disallowed — never spend then discover.
 */
export async function reserveModelCall(
  db: PrismaClient,
  input: { workspaceId: string; purpose: WorkspaceModelPurpose; now?: Date },
): Promise<BudgetDecision> {
  const now = input.now ?? new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const config = await db.workspaceModelConfiguration.findUnique({
    where: { workspaceId: input.workspaceId },
    select: { dailyBudget: true },
  });
  if (!config) return { allowed: false, callsToday: 0, budget: 0 };

  await db.workspaceModelUsage.upsert({
    where: {
      workspaceId_purpose_day: {
        workspaceId: input.workspaceId,
        purpose: input.purpose,
        day,
      },
    },
    create: { workspaceId: input.workspaceId, purpose: input.purpose, day, calls: 0 },
    update: {},
    select: { calls: true },
  });
  const reserved = await db.workspaceModelUsage.updateMany({
    where: {
      workspaceId: input.workspaceId,
      purpose: input.purpose,
      day,
      calls: { lt: config.dailyBudget },
    },
    data: { calls: { increment: 1 } },
  });
  const current = await db.workspaceModelUsage.findUniqueOrThrow({
    where: {
      workspaceId_purpose_day: {
        workspaceId: input.workspaceId,
        purpose: input.purpose,
        day,
      },
    },
    select: { calls: true },
  });
  if (reserved.count !== 1)
    return { allowed: false, callsToday: current.calls, budget: config.dailyBudget };
  return { allowed: true, callsToday: current.calls };
}

export async function modelCallsUsedToday(
  db: PrismaClient,
  input: { workspaceId: string; purpose: WorkspaceModelPurpose; now?: Date },
): Promise<number> {
  const now = input.now ?? new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const row = await db.workspaceModelUsage.findUnique({
    where: {
      workspaceId_purpose_day: { workspaceId: input.workspaceId, purpose: input.purpose, day },
    },
    select: { calls: true },
  });
  return row?.calls ?? 0;
}

async function assertWorkspaceManager(
  db: PrismaClient,
  principal: { workspaceId: string; userId: string },
): Promise<void> {
  const membership = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId: principal.workspaceId, userId: principal.userId } },
    select: { role: true },
  });
  if (!membership || (membership.role !== "owner" && membership.role !== "admin"))
    throw new AppError("ACCESS_DENIED", { errorId: "gm-config-role" });
}

function principalScope(workspaceId: string, providerId: string) {
  return { workspaceId, providerId };
}

async function encryptApiKey(workspaceId: string, providerId: string, apiKeyInput: string) {
  const encryptionKey = readAgentRuntimeCredentialEncryptionKey(process.env);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: associatedData(workspaceId, providerId),
      },
      await crypto.subtle.importKey("raw", encryptionKey, "AES-GCM", false, ["encrypt"]),
      new TextEncoder().encode(apiKeyInput),
    ),
  );
  return {
    keyId: KEY_ID,
    ciphertext: Buffer.from(encrypted).toString("base64"),
    nonce: Buffer.from(nonce).toString("base64"),
    hint: `••••${apiKeyInput.slice(-4)}`,
  };
}

async function decryptApiKey(
  scope: { workspaceId: string; providerId: string },
  encrypted: { keyId: string; ciphertext: string; nonce: string },
): Promise<string> {
  if (encrypted.keyId !== KEY_ID)
    throw new Error("Workspace model credential key id is unsupported");
  const encryptionKey = readAgentRuntimeCredentialEncryptionKey(process.env);
  const key = await crypto.subtle.importKey("raw", encryptionKey, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Buffer.from(encrypted.nonce, "base64"),
      additionalData: associatedData(scope.workspaceId, scope.providerId),
    },
    key,
    Buffer.from(encrypted.ciphertext, "base64"),
  );
  return new TextDecoder().decode(plaintext);
}

function parseEncryptedApiKey(
  value: Prisma.JsonValue | null | undefined,
): { keyId: string; ciphertext: string; nonce: string; hint: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.keyId !== "string" ||
    typeof record.ciphertext !== "string" ||
    typeof record.nonce !== "string" ||
    typeof record.hint !== "string"
  )
    return null;
  return {
    keyId: record.keyId,
    ciphertext: record.ciphertext,
    nonce: record.nonce,
    hint: record.hint,
  };
}

function validateApiKey(value: string) {
  const apiKey = value.trim();
  if (apiKey.length < API_KEY_MIN_LENGTH)
    throw new AppError("INVALID_INPUT", { errorId: "gm-config-key" });
  if (apiKey.length > API_KEY_MAX_LENGTH)
    throw new AppError("INVALID_INPUT", { errorId: "gm-config-key" });
  return apiKey;
}

function associatedData(workspaceId: string, providerId: string) {
  return new TextEncoder().encode(`${AAD_SCOPE}\0${workspaceId}\0${providerId}`);
}
