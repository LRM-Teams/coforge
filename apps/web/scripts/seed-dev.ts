/**
 * Idempotent dev-data seed: puts every page in the app into a populated state.
 *
 * Run with `bun run seed:dev` (needs DATABASE_URL from apps/web/.env and
 * REDIS_URL, same as the dev server). Safe to rerun — every row is addressed
 * by a deterministic id derived from a stable seed key, so a rerun updates
 * existing rows instead of duplicating them.
 *
 * Two kinds of state live outside Postgres and are seeded directly into
 * Redis, in the exact key/value shape the app's own caches use:
 *   - Agent "active" status (`coforge:agent-status:v2:...`)
 *   - Computer online/offline status (`coforge:computer-status:v1:...`)
 *   - Runtime usage snapshots (`coforge:usage:v1:...`)
 * These caches normally expire in 60-90s because a live daemon refreshes
 * them; this seed sets a ~24h TTL instead so the data survives a dev
 * session, but it will go stale (agents will look "inactive", computers
 * "offline", usage gone) after about a day — rerun the seed to refresh.
 */
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { RedisClient } from "bun";
import { DEV_BROWSER_USER } from "../src/server/auth/dev-skip-auth.server";
import { getDatabaseClient } from "../src/server/db/client.server";
import { workspaceIdForUser } from "../src/server/workspaces/enrollment.server";
import { fileStoragePath } from "../src/server/files/file-storage.server";
import { assignMissingSeedSequences, orderSeedMessages, seedTimestamp } from "./seed-dev-time";

const dbOrUndefined = getDatabaseClient();
if (!dbOrUndefined) throw new Error("DATABASE_URL is required to seed development data");
const db = dbOrUndefined;

const redisUrl = process.env.REDIS_URL;
if (!redisUrl)
  throw new Error(
    "REDIS_URL is required to seed development data (Agent/Computer status live in Redis)",
  );
const redis = new RedisClient(redisUrl);
const DAY_TTL = "86400";

// ---------------------------------------------------------------------------
// Deterministic ids — sha256(seed) reshaped into a UUID so reruns update
// rows in place instead of creating duplicates.
// ---------------------------------------------------------------------------
function stableId(seed: string): string {
  const hash = createHash("sha256").update(`coforge-dev-seed:${seed}`).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `${((Number.parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16)}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

const capturedNow = new Date();

function daysAgo(days: number, hour = 12, minute = 0): Date {
  return seedTimestamp(capturedNow, days, hour, minute);
}

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 3_600_000);
}

console.log("Seeding CoForge dev data…");

// ---------------------------------------------------------------------------
// Dev user + workspace (reuses the same helpers the app itself uses).
// ---------------------------------------------------------------------------
await db.user.upsert({
  where: { id: DEV_BROWSER_USER.id },
  create: {
    id: DEV_BROWSER_USER.id,
    username: DEV_BROWSER_USER.username,
    displayName: DEV_BROWSER_USER.name,
  },
  update: { username: DEV_BROWSER_USER.username, displayName: DEV_BROWSER_USER.name },
});
const workspaceId = await workspaceIdForUser(db, DEV_BROWSER_USER, "en");
const workspace = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
console.log(`Workspace: ${workspace.slug} (${workspaceId})`);

// ---------------------------------------------------------------------------
// Extra humans: two more workspace members, one pending invitee.
// ---------------------------------------------------------------------------
const jordanId = stableId("user:jordan-lee");
const caseyId = stableId("user:casey-morgan");
const rileyId = stableId("user:riley-chen"); // not a member — invitee only

await db.user.upsert({
  where: { id: jordanId },
  create: { id: jordanId, username: "jordan-lee", displayName: "Jordan Lee" },
  update: { displayName: "Jordan Lee" },
});
await db.user.upsert({
  where: { id: caseyId },
  create: { id: caseyId, username: "casey-morgan", displayName: "Casey Morgan" },
  update: { displayName: "Casey Morgan" },
});
await db.user.upsert({
  where: { id: rileyId },
  create: { id: rileyId, username: "riley-chen", displayName: "Riley Chen" },
  update: { displayName: "Riley Chen" },
});

await db.workspaceMembership.upsert({
  where: { workspaceId_userId: { workspaceId, userId: jordanId } },
  create: { workspaceId, userId: jordanId, role: "admin" },
  update: { role: "admin" },
});
await db.workspaceMembership.upsert({
  where: { workspaceId_userId: { workspaceId, userId: caseyId } },
  create: { workspaceId, userId: caseyId, role: "member" },
  update: { role: "member" },
});

const invitationId = stableId("invitation:riley-chen");
await db.workspaceInvitation.upsert({
  where: { id: invitationId },
  create: {
    id: invitationId,
    workspaceId,
    inviterUserId: DEV_BROWSER_USER.id,
    inviteeUserId: rileyId,
    role: "member",
    status: "pending",
    expiresAt: hoursFromNow(24 * 7),
  },
  update: { status: "pending", expiresAt: hoursFromNow(24 * 7) },
});

console.log("Members: dev-user (owner), jordan-lee (admin), casey-morgan (member)");
console.log("Pending invitation: riley-chen (member)");

// ---------------------------------------------------------------------------
// Computers: one online with three detected runtimes + usage, one offline.
// FAKED: there is no live daemon in dev, so `online` status, the runtime
// list, and usage snapshots are written straight into the same Redis/DB
// rows a real daemon connection would populate — nothing here is scanned.
// ---------------------------------------------------------------------------
const computerOnlineId = stableId("computer:online");
const computerOfflineId = stableId("computer:offline");

await db.computer.upsert({
  where: { id: computerOnlineId },
  create: {
    id: computerOnlineId,
    ownerId: DEV_BROWSER_USER.id,
    machineId: "seed-machine-online",
    name: "mac-studio-01",
    displayName: "Mac Studio",
    computerVersion: "4.6.2",
    platform: "darwin",
    osVersion: "26.1",
    kind: "local",
    metadataStartedAt: BigInt(Date.now() - 6 * 3_600_000),
  },
  update: {
    displayName: "Mac Studio",
    computerVersion: "4.6.2",
    platform: "darwin",
    osVersion: "26.1",
    metadataStartedAt: BigInt(Date.now() - 6 * 3_600_000),
  },
});
await db.computer.upsert({
  where: { id: computerOfflineId },
  create: {
    id: computerOfflineId,
    ownerId: DEV_BROWSER_USER.id,
    machineId: "seed-machine-offline",
    name: "cloud-sandbox-01",
    displayName: "Cloud Sandbox",
    computerVersion: "4.5.9",
    platform: "linux",
    osVersion: "6.8",
    kind: "cloud",
    metadataStartedAt: BigInt(Date.now() - 5 * 86_400_000),
  },
  update: {
    displayName: "Cloud Sandbox",
    computerVersion: "4.5.9",
    platform: "linux",
    osVersion: "6.8",
  },
});

for (const computerId of [computerOnlineId, computerOfflineId]) {
  await db.workspaceComputer.upsert({
    where: { workspaceId_computerId: { workspaceId, computerId } },
    create: { workspaceId, computerId },
    update: {},
  });
}

const onlineRuntimes = [
  { provider: "claude-code", version: "2.4.1", displayName: "Claude Code", isPublic: true },
  { provider: "codex", version: "0.42.0", displayName: "Codex CLI", isPublic: false },
  { provider: "pi", version: "1.8.3", displayName: "Pi", isPublic: false },
] as const;
for (const runtime of onlineRuntimes) {
  await db.computerRuntime.upsert({
    where: {
      workspaceId_computerId_provider: {
        workspaceId,
        computerId: computerOnlineId,
        provider: runtime.provider,
      },
    },
    create: { workspaceId, computerId: computerOnlineId, ...runtime },
    update: {
      version: runtime.version,
      displayName: runtime.displayName,
      isPublic: runtime.isPublic,
    },
  });
}
await db.computerRuntime.upsert({
  where: {
    workspaceId_computerId_provider: {
      workspaceId,
      computerId: computerOfflineId,
      provider: "claude-code",
    },
  },
  create: {
    workspaceId,
    computerId: computerOfflineId,
    provider: "claude-code",
    version: "2.3.0",
    displayName: "Claude Code",
    isPublic: false,
    observedAt: daysAgo(4),
  },
  update: { observedAt: daysAgo(4) },
});

// Redis: computer online/offline status (normally set by a live daemon heartbeat).
await redis.set(
  `coforge:computer-status:v1:${encodeURIComponent(workspaceId)}:${encodeURIComponent(computerOnlineId)}`,
  "online",
  "EX",
  DAY_TTL,
);
await redis.set(
  `coforge:computer-status:v1:${encodeURIComponent(workspaceId)}:${encodeURIComponent(computerOfflineId)}`,
  "offline",
  "EX",
  DAY_TTL,
);

// Redis: usage snapshots for the online Computer's three runtimes (normally
// written after a live usage scan against the provider's account API).
const usageByProvider: Record<string, { primaryPercent: number; secondaryPercent?: number }> = {
  "claude-code": { primaryPercent: 42, secondaryPercent: 18 },
  codex: { primaryPercent: 76 },
  pi: { primaryPercent: 9 },
};
for (const runtime of onlineRuntimes) {
  const usage = usageByProvider[runtime.provider]!;
  const record = {
    workspaceId,
    computerId: computerOnlineId,
    provider: runtime.provider,
    scanId: stableId(`usage-scan:${runtime.provider}`),
    status: "available" as const,
    snapshot: {
      provider: runtime.provider,
      planType: runtime.provider === "claude-code" ? "Max" : "Plus",
      primary: {
        usedPercent: usage.primaryPercent,
        status: "available" as const,
        windowDurationMinutes: 300,
        resetsAt: hoursFromNow(3).toISOString(),
      },
      ...(usage.secondaryPercent === undefined
        ? {}
        : {
            secondary: {
              usedPercent: usage.secondaryPercent,
              status: "available" as const,
              windowDurationMinutes: 10_080,
              resetsAt: hoursFromNow(96).toISOString(),
            },
          }),
      credits: { hasCredits: true, unlimited: false },
    },
  };
  await redis.set(
    `coforge:usage:v1:${encodeURIComponent(workspaceId)}:${encodeURIComponent(computerOnlineId)}:${encodeURIComponent(runtime.provider)}`,
    JSON.stringify(record),
    "EX",
    DAY_TTL,
  );
}

console.log("Computers: mac-studio-01 (online, 3 runtimes + usage), cloud-sandbox-01 (offline)");

// ---------------------------------------------------------------------------
// Agents: two active (different runtimes), one inactive.
// FAKED: "active" is a Redis lease a running daemon renews every few
// seconds; there is no daemon in dev, so this seed writes the lease record
// directly with a long TTL instead of it being renewed.
// ---------------------------------------------------------------------------
const agentAtlasId = stableId("agent:atlas");
const agentNovaId = stableId("agent:nova");
const agentEchoId = stableId("agent:echo");

await db.agent.upsert({
  where: { id: agentAtlasId },
  create: {
    id: agentAtlasId,
    workspaceId,
    name: "atlas",
    displayName: "Atlas",
    description: "Ships the weekly release notes and triages incoming bug reports.",
    ownerId: DEV_BROWSER_USER.id,
    computerId: computerOnlineId,
    runtimeConfig: {
      runtime: "claude-code",
      provider: { kind: "default" },
      model: "claude-opus-4-6",
      modelProvider: "",
      reasoning: "high",
    },
  },
  update: {
    computerId: computerOnlineId,
    runtimeConfig: {
      runtime: "claude-code",
      provider: { kind: "default" },
      model: "claude-opus-4-6",
      modelProvider: "",
      reasoning: "high",
    },
  },
});
await db.agent.upsert({
  where: { id: agentNovaId },
  create: {
    id: agentNovaId,
    workspaceId,
    name: "nova",
    displayName: "Nova",
    description: "Reviews pull requests and keeps the changelog current.",
    ownerId: jordanId,
    computerId: computerOnlineId,
    runtimeConfig: {
      runtime: "codex",
      provider: { kind: "default" },
      model: "gpt-5.1-codex",
      modelProvider: "",
      reasoning: "medium",
    },
  },
  update: {
    computerId: computerOnlineId,
    runtimeConfig: {
      runtime: "codex",
      provider: { kind: "default" },
      model: "gpt-5.1-codex",
      modelProvider: "",
      reasoning: "medium",
    },
  },
});
await db.agent.upsert({
  where: { id: agentEchoId },
  create: {
    id: agentEchoId,
    workspaceId,
    name: "echo",
    displayName: "Echo",
    description: "Runs the nightly data export on the cloud sandbox.",
    ownerId: DEV_BROWSER_USER.id,
    computerId: computerOfflineId,
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
  },
  update: { computerId: computerOfflineId },
});

async function setAgentActive(agentId: string, computerId: string) {
  const key = `coforge:agent-status:v2:${encodeURIComponent(workspaceId)}:${encodeURIComponent(computerId)}:${encodeURIComponent(agentId)}`;
  const record = {
    status: "active" as const,
    daemonInstanceId: stableId(`daemon:${agentId}`),
    clientSeq: 1,
    observedAtMs: Date.now(),
  };
  await redis.set(key, JSON.stringify(record), "EX", DAY_TTL);
}
async function clearAgentStatus(agentId: string, computerId: string) {
  const key = `coforge:agent-status:v2:${encodeURIComponent(workspaceId)}:${encodeURIComponent(computerId)}:${encodeURIComponent(agentId)}`;
  await redis.del(key);
}
await setAgentActive(agentAtlasId, computerOnlineId);
await setAgentActive(agentNovaId, computerOnlineId);
await clearAgentStatus(agentEchoId, computerOfflineId); // stays inactive (no Redis lease)

console.log("Agents: atlas (active, claude-code), nova (active, codex), echo (inactive, pi)");

// ---------------------------------------------------------------------------
// Conversations: public channels + one direct conversation per Agent.
// ---------------------------------------------------------------------------
async function ensureMember(
  conversationId: string,
  ref: { userId?: string; agentId?: string },
): Promise<string> {
  const id = stableId(`member:${conversationId}:${ref.userId ?? ref.agentId}`);
  if (ref.userId) {
    await db.conversationMember.upsert({
      where: { conversationId_userId: { conversationId, userId: ref.userId } },
      create: { id, conversationId, workspaceId, userId: ref.userId },
      update: {},
    });
  } else {
    await db.conversationMember.upsert({
      where: { conversationId_agentId: { conversationId, agentId: ref.agentId! } },
      create: { id, conversationId, workspaceId, agentId: ref.agentId },
      update: {},
    });
  }
  const row = await db.conversationMember.findFirstOrThrow({
    where: ref.userId
      ? { conversationId, userId: ref.userId }
      : { conversationId, agentId: ref.agentId },
    select: { id: true },
  });
  return row.id;
}

async function ensureChannel(channelName: string): Promise<string> {
  const id = stableId(`conversation:channel:${channelName}`);
  await db.conversation.upsert({
    where: { workspaceId_channelName: { workspaceId, channelName } },
    create: { id, workspaceId, channelName },
    update: {},
  });
  const row = await db.conversation.findUniqueOrThrow({
    where: { workspaceId_channelName: { workspaceId, channelName } },
    select: { id: true },
  });
  return row.id;
}

async function ensureDirectConversation(agentId: string): Promise<string> {
  const directKey = `agent:${agentId}|user:${DEV_BROWSER_USER.id}`;
  const id = stableId(`conversation:dm:${agentId}`);
  await db.conversation.upsert({
    where: { workspaceId_directKey: { workspaceId, directKey } },
    create: { id, workspaceId, directKey },
    update: {},
  });
  const row = await db.conversation.findUniqueOrThrow({
    where: { workspaceId_directKey: { workspaceId, directKey } },
    select: { id: true },
  });
  return row.id;
}

const generalId = await ensureChannel("general");
const productId = await ensureChannel("product");
const randomId = await ensureChannel("random"); // dev user is deliberately not a member of this one

const devInGeneral = await ensureMember(generalId, { userId: DEV_BROWSER_USER.id });
const jordanInGeneral = await ensureMember(generalId, { userId: jordanId });
await ensureMember(generalId, { userId: caseyId });
const atlasInGeneral = await ensureMember(generalId, { agentId: agentAtlasId });

const devInProduct = await ensureMember(productId, { userId: DEV_BROWSER_USER.id });
const jordanInProduct = await ensureMember(productId, { userId: jordanId });
const novaInProduct = await ensureMember(productId, { agentId: agentNovaId });

// dev-user intentionally has no membership row in #random
const caseyInRandom = await ensureMember(randomId, { userId: caseyId });
const echoInRandom = await ensureMember(randomId, { agentId: agentEchoId });

const dmAtlasId = await ensureDirectConversation(agentAtlasId);
const devInDmAtlas = await ensureMember(dmAtlasId, { userId: DEV_BROWSER_USER.id });
const atlasInDmAtlas = await ensureMember(dmAtlasId, { agentId: agentAtlasId });

const dmNovaId = await ensureDirectConversation(agentNovaId);
const devInDmNova = await ensureMember(dmNovaId, { userId: DEV_BROWSER_USER.id });
const novaInDmNova = await ensureMember(dmNovaId, { agentId: agentNovaId });

const dmEchoId = await ensureDirectConversation(agentEchoId);
const devInDmEcho = await ensureMember(dmEchoId, { userId: DEV_BROWSER_USER.id });
const echoInDmEcho = await ensureMember(dmEchoId, { agentId: agentEchoId });

console.log("Channels: #general, #product (joined), #random (not joined by dev-user)");
console.log("Direct conversations: dev-user × atlas, × nova, × echo");

// ---------------------------------------------------------------------------
// Messages (~40 across channels + DMs, spanning several days), a 5-reply
// thread, and a few attachments (real files under .data/files, matching
// what the app itself writes on upload).
// ---------------------------------------------------------------------------
async function ensureMessage(opts: {
  key: string;
  conversationId: string;
  senderMemberId: string;
  body: string;
  createdAt: Date;
  threadRootId?: string;
}): Promise<string> {
  const id = stableId(`message:${opts.key}`);
  pendingMessages.push({ ...opts, id });
  return id;
}

const pendingMessages: Array<{
  id: string;
  key: string;
  conversationId: string;
  senderMemberId: string;
  body: string;
  createdAt: Date;
  threadRootId?: string;
}> = [];

async function ensureAttachment(opts: {
  key: string;
  conversationId: string;
  uploaderId: string;
  messageId: string;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}) {
  const id = stableId(`attachment:${opts.key}`);
  const objectKey = `workspaces/${workspaceId}/attachments/${id}/original`;
  const path = fileStoragePath(objectKey);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, opts.bytes);
  pendingAttachments.push({
    id,
    objectKey,
    ...opts,
  });
}

const pendingAttachments: Array<
  Parameters<typeof ensureAttachment>[0] & { id: string; objectKey: string }
> = [];

async function insertPendingAttachments() {
  for (const opts of pendingAttachments)
    await db.attachment.upsert({
      where: { id: opts.id },
      create: {
        id: opts.id,
        workspaceId,
        conversationId: opts.conversationId,
        uploaderId: opts.uploaderId,
        messageId: opts.messageId,
        objectKey: opts.objectKey,
        fileName: opts.fileName,
        contentType: opts.contentType,
        sizeBytes: opts.bytes.length,
      },
      update: {
        messageId: opts.messageId,
        fileName: opts.fileName,
        contentType: opts.contentType,
        sizeBytes: opts.bytes.length,
      },
    });
}

// 1x1 transparent PNG.
const PNG_1PX = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);
const TEXT_FILE = new TextEncoder().encode(
  "release-notes.txt\n\n- Fixed sidebar resize jank\n- Added dark mode to the task board\n",
);

// #general — 10 messages, one with a PNG attachment.
const generalMsgs: string[] = [];
for (const [key, senderMemberId, body, dayOffset] of [
  ["g1", devInGeneral, "Morning — kicking off the sprint, let's sync at 10.", 6],
  ["g2", atlasInGeneral, "Nightly build is green across all three runtimes.", 6],
  ["g3", jordanInGeneral, "Heads up, I'm deploying a hotfix to staging in 20 min.", 5],
  ["g4", devInGeneral, "Sounds good, ping #product if it touches the task board.", 5],
  ["g5", atlasInGeneral, "Filed 3 bug reports from the overnight crash logs.", 4],
  ["g6", jordanInGeneral, "Here's the updated architecture diagram.", 3],
  ["g7", devInGeneral, "Nice, that clears up the computer/runtime split.", 3],
  ["g8", atlasInGeneral, "Reminder: usage on the Codex plan is at 76% for the week.", 2],
  ["g9", jordanInGeneral, "Noted, I'll switch Nova to a lighter model for now.", 1],
  ["g10", devInGeneral, "Let's close out the week with a short retro tomorrow.", 0],
] as const) {
  const id = await ensureMessage({
    key,
    conversationId: generalId,
    senderMemberId,
    body,
    createdAt: daysAgo(dayOffset, 9 + (generalMsgs.length % 6)),
  });
  generalMsgs.push(id);
  if (key === "g6") {
    await ensureAttachment({
      key: "general-diagram",
      conversationId: generalId,
      uploaderId: jordanId,
      messageId: id,
      fileName: "architecture.png",
      contentType: "image/png",
      bytes: PNG_1PX,
    });
  }
}

// #product — 9 regular messages + a thread root with 5 replies (15 total),
// one message with a text attachment.
const productMsgs: string[] = [];
for (const [key, senderMemberId, body, dayOffset] of [
  ["p1", devInProduct, "Starting the task board redesign discussion here.", 6],
  ["p2", novaInProduct, "Opened PR #482 with the first pass at the column layout.", 5],
  ["p3", jordanInProduct, "Left a few comments, mostly about empty states.", 5],
  ["p4", devInProduct, "Good catch, empty states need one line not three.", 4],
  ["p5", novaInProduct, "Updated, attaching the release notes for this cut.", 4],
] as const) {
  const id = await ensureMessage({
    key,
    conversationId: productId,
    senderMemberId,
    body,
    createdAt: daysAgo(dayOffset, 10 + (productMsgs.length % 5)),
  });
  productMsgs.push(id);
  if (key === "p5") {
    await ensureAttachment({
      key: "product-release-notes",
      conversationId: productId,
      uploaderId: jordanId,
      messageId: id,
      fileName: "release-notes.txt",
      contentType: "text/plain",
      bytes: TEXT_FILE,
    });
  }
}

const threadRootId = await ensureMessage({
  key: "p-thread-root",
  conversationId: productId,
  senderMemberId: devInProduct,
  body: "Thread: how should we badge tasks converted from a message?",
  createdAt: daysAgo(3, 11),
});
productMsgs.push(threadRootId);
for (const [key, senderMemberId, body] of [
  ["p-reply-1", novaInProduct, "A small paperclip-style icon next to the title reads well."],
  ["p-reply-2", jordanInProduct, "Agreed, plus a tooltip with the source message on hover."],
  ["p-reply-3", devInProduct, "Let's keep it to the icon — no tooltip copy per the UI guidelines."],
  ["p-reply-4", novaInProduct, "Works, I'll drop the tooltip from the PR."],
  ["p-reply-5", jordanInProduct, "PR updated, ready for another look."],
] as const) {
  const id = await ensureMessage({
    key,
    conversationId: productId,
    senderMemberId,
    body,
    createdAt: daysAgo(3, 12),
    threadRootId,
  });
  productMsgs.push(id);
}

for (const [key, senderMemberId, body, dayOffset] of [
  ["p6", devInProduct, "Merged. Rolling out to the rest of the board views next.", 2],
  ["p7", novaInProduct, "Board, list, and the channel tasks tab are all consistent now.", 1],
  ["p8", jordanInProduct, "Nice work all around.", 1],
  ["p9", devInProduct, "Filing follow-up tasks for the remaining polish items.", 0],
] as const) {
  const id = await ensureMessage({
    key,
    conversationId: productId,
    senderMemberId,
    body,
    createdAt: daysAgo(dayOffset, 14),
  });
  productMsgs.push(id);
}

// #random — 5 messages, dev-user is not a member so never posts here.
const randomMsgs: string[] = [];
for (const [key, senderMemberId, body, dayOffset] of [
  ["r1", caseyInRandom, "Anyone want the extra conference badge for next month?", 4],
  ["r2", echoInRandom, "I can't attend, cloud sandboxes don't do conferences.", 4],
  ["r3", caseyInRandom, "Fair. Coffee machine on 3 is fixed, by the way.", 3],
  ["r4", echoInRandom, "Logging that as a high-priority incident resolved.", 2],
  ["r5", caseyInRandom, "As it should be.", 1],
] as const) {
  const id = await ensureMessage({
    key,
    conversationId: randomId,
    senderMemberId,
    body,
    createdAt: daysAgo(dayOffset, 15),
  });
  randomMsgs.push(id);
}

// DM with Atlas — 5 messages, one with a PNG attachment.
const dmAtlasMsgs: string[] = [];
for (const [key, senderMemberId, body, dayOffset] of [
  ["da1", devInDmAtlas, "Can you summarize yesterday's crash reports?", 3],
  [
    "da2",
    atlasInDmAtlas,
    "3 crashes, all the same null computerId edge case. Fix is up in #general.",
    3,
  ],
  ["da3", devInDmAtlas, "Great, attaching the repro screenshot for reference.", 2],
  ["da4", atlasInDmAtlas, "Matches what I saw. I'll add a regression test.", 2],
  ["da5", devInDmAtlas, "Perfect, thank you.", 1],
] as const) {
  const id = await ensureMessage({
    key,
    conversationId: dmAtlasId,
    senderMemberId,
    body,
    createdAt: daysAgo(dayOffset, 16),
  });
  dmAtlasMsgs.push(id);
  if (key === "da3") {
    await ensureAttachment({
      key: "dm-atlas-repro",
      conversationId: dmAtlasId,
      uploaderId: DEV_BROWSER_USER.id,
      messageId: id,
      fileName: "repro.png",
      contentType: "image/png",
      bytes: PNG_1PX,
    });
  }
}

// DM with Nova — 3 messages.
const dmNovaMsgs: string[] = [];
for (const [key, senderMemberId, body, dayOffset] of [
  ["dn1", devInDmNova, "How's the PR review queue looking?", 2],
  ["dn2", novaInDmNova, "Two open, both small. I'll clear them today.", 2],
  ["dn3", devInDmNova, "Thanks, no rush.", 1],
] as const) {
  const id = await ensureMessage({
    key,
    conversationId: dmNovaId,
    senderMemberId,
    body,
    createdAt: daysAgo(dayOffset, 13),
  });
  dmNovaMsgs.push(id);
}

// DM with Echo — 2 messages.
const dmEchoMsgs: string[] = [];
for (const [key, senderMemberId, body, dayOffset] of [
  ["de1", devInDmEcho, "Did the nightly export finish?", 1],
  ["de2", echoInDmEcho, "Not yet — the sandbox has been offline since last night.", 0],
] as const) {
  const id = await ensureMessage({
    key,
    conversationId: dmEchoId,
    senderMemberId,
    body,
    createdAt: daysAgo(dayOffset, 8),
  });
  dmEchoMsgs.push(id);
}

console.log(
  `Messages: ${generalMsgs.length} in #general, ${productMsgs.length} in #product (incl. 1 thread root + 5 replies), ${randomMsgs.length} in #random, ${dmAtlasMsgs.length + dmNovaMsgs.length + dmEchoMsgs.length} across DMs — 3 with attachments`,
);

// ---------------------------------------------------------------------------
// Tasks: 6, message-backed (every Task row in this schema *is* a converted
// message), covering all five statuses plus a second todo to show an
// unowned vs. owned card.
// ---------------------------------------------------------------------------
async function ensureTask(opts: {
  key: string;
  conversationId: string;
  number: number;
  title: string;
  status: "todo" | "in_progress" | "in_review" | "done" | "closed";
  creatorMemberId: string;
  ownerMemberId?: string;
  senderMemberId: string;
  dayOffset: number;
}) {
  const messageId = await ensureMessage({
    key: `task-source:${opts.key}`,
    conversationId: opts.conversationId,
    senderMemberId: opts.senderMemberId,
    body: opts.title,
    createdAt: daysAgo(opts.dayOffset, 17),
  });
  pendingTasks.push({ messageId, ...opts });
}

const pendingTasks: Array<Parameters<typeof ensureTask>[0] & { messageId: string }> = [];

async function insertPendingTasks() {
  for (const opts of pendingTasks)
    await db.task.upsert({
      where: { messageId: opts.messageId },
      create: {
        messageId: opts.messageId,
        conversationId: opts.conversationId,
        workspaceId,
        number: opts.number,
        title: opts.title,
        status: opts.status,
        creatorMemberId: opts.creatorMemberId,
        ownerMemberId: opts.ownerMemberId,
        requestId: stableId(`task-request:${opts.key}`),
      },
      update: {
        title: opts.title,
        status: opts.status,
        ownerMemberId: opts.ownerMemberId ?? null,
      },
    });
}

await ensureTask({
  key: "todo-unowned",
  conversationId: generalId,
  number: 1,
  title: "Write a migration guide for the runtime credential rotation",
  status: "todo",
  creatorMemberId: devInGeneral,
  senderMemberId: devInGeneral,
  dayOffset: 5,
});
await ensureTask({
  key: "todo-owned",
  conversationId: productId,
  number: 1,
  title: "Design the empty state for a channel with no tasks",
  status: "todo",
  creatorMemberId: devInProduct,
  ownerMemberId: jordanInProduct,
  senderMemberId: devInProduct,
  dayOffset: 5,
});
await ensureTask({
  key: "in-progress",
  conversationId: productId,
  number: 2,
  title: "Add hover popover for runtime usage on the computer detail page",
  status: "in_progress",
  creatorMemberId: jordanInProduct,
  ownerMemberId: novaInProduct,
  senderMemberId: jordanInProduct,
  dayOffset: 4,
});
await ensureTask({
  key: "in-review",
  conversationId: generalId,
  number: 2,
  title: "Standardize loading and toast feedback across settings tabs",
  status: "in_review",
  creatorMemberId: devInGeneral,
  ownerMemberId: atlasInGeneral,
  senderMemberId: atlasInGeneral,
  dayOffset: 3,
});
await ensureTask({
  key: "done",
  conversationId: productId,
  number: 3,
  title: "Unify mobile navigation and workspace member list",
  status: "done",
  creatorMemberId: novaInProduct,
  ownerMemberId: devInProduct,
  senderMemberId: novaInProduct,
  dayOffset: 2,
});
await ensureTask({
  key: "closed",
  conversationId: generalId,
  number: 3,
  title: "Investigate flaky agent-control-runtime test",
  status: "closed",
  creatorMemberId: jordanInGeneral,
  ownerMemberId: devInGeneral,
  senderMemberId: jordanInGeneral,
  dayOffset: 6,
});

const orderedMessages = orderSeedMessages(pendingMessages);
await db.$transaction(async (tx) => {
  const conversationIds = [
    ...new Set(orderedMessages.map(({ conversationId }) => conversationId)),
  ].sort();
  for (const conversationId of conversationIds)
    await tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "id" = ${conversationId}::uuid FOR UPDATE`;

  const existingMessages = await tx.message.findMany({
    where: { conversationId: { in: conversationIds } },
    select: { id: true, conversationId: true, sequence: true },
  });
  const existingIds = new Set(existingMessages.map(({ id }) => id));
  const newSequences = new Map(
    assignMissingSeedSequences(orderedMessages, existingMessages).map(({ id, sequence }) => [
      id,
      sequence,
    ]),
  );

  for (const message of orderedMessages) {
    if (existingIds.has(message.id)) {
      await tx.message.update({
        where: { id: message.id },
        data: {
          body: message.body,
          senderMemberId: message.senderMemberId,
          threadRootId: message.threadRootId,
        },
      });
    } else {
      const sequence = newSequences.get(message.id);
      if (sequence === undefined)
        throw new Error(`Missing sequence for seed message ${message.key}`);
      await tx.message.create({
        data: {
          id: message.id,
          conversationId: message.conversationId,
          workspaceId,
          senderMemberId: message.senderMemberId,
          body: message.body,
          sequence,
          createdAt: message.createdAt,
          threadRootId: message.threadRootId,
        },
      });
    }
  }
});
await insertPendingAttachments();
await insertPendingTasks();

console.log("Tasks: todo (unowned), todo (owned), in_progress, in_review, done, closed");

// ---------------------------------------------------------------------------
// Reminders: 2, agent-owned.
// ---------------------------------------------------------------------------
async function ensureReminder(opts: {
  key: string;
  ownerAgentId: string;
  computerId: string;
  title: string;
  target: string;
  messageId: string;
  fireAt: Date;
  repeat: string | null;
  timezone: string | null;
}) {
  const id = stableId(`reminder:${opts.key}`);
  await db.reminder.upsert({
    where: { id },
    create: {
      id,
      workspaceId,
      ownerAgentId: opts.ownerAgentId,
      computerId: opts.computerId,
      title: opts.title,
      target: opts.target,
      messageId: opts.messageId,
      fireAt: opts.fireAt,
      repeat: opts.repeat,
      timezone: opts.timezone,
      status: "scheduled",
    },
    update: {
      title: opts.title,
      target: opts.target,
      fireAt: opts.fireAt,
      repeat: opts.repeat,
      timezone: opts.timezone,
      status: "scheduled",
    },
  });
}

await ensureReminder({
  key: "ping-general",
  ownerAgentId: agentAtlasId,
  computerId: computerOnlineId,
  title: "Post the weekly release summary",
  target: "#general",
  messageId: generalMsgs[generalMsgs.length - 1]!,
  fireAt: hoursFromNow(3),
  repeat: null,
  timezone: "America/Los_Angeles",
});
await ensureReminder({
  key: "daily-standup",
  ownerAgentId: agentNovaId,
  computerId: computerOnlineId,
  title: "Post the daily standup summary",
  target: `@${DEV_BROWSER_USER.username}`,
  messageId: dmNovaMsgs[dmNovaMsgs.length - 1]!,
  fireAt: (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(9, 30, 0, 0);
    return d;
  })(),
  repeat: "daily@09:30",
  timezone: "America/Los_Angeles",
});

console.log("Reminders: 1 one-off (atlas → #general), 1 daily (nova → @dev-user)");

await db.$disconnect();
console.log("Seed complete.");
