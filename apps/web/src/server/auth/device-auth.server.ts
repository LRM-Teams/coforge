import { createHash, randomBytes, randomInt } from "node:crypto";

import {
  formatUserCode,
  normalizeUserCode,
  USER_CODE_LENGTH,
} from "../../features/device-auth/device-code-format";
import { signComputerAccessToken } from "./computer-access-token.server";

/**
 * RFC 8628 device authorization grant - the real one. The E2E double in
 * e2e-device-auth.server.ts stays beside it: the end-to-end harness drives an unattended install
 * with a fixed code, which no real implementation can offer.
 */

/** Deliberately excludes I/L/O/0/1/U - a code is read off one screen and typed into another, so
 * every pair a person confuses is a support ticket. U is dropped so the alphabet cannot spell
 * unfortunate words. 8 characters over 26 symbols is ~38 bits, which the attempt limit below is
 * what actually protects; the alphabet only makes the code transcribable. */
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789";

export const DEVICE_CODE_TTL_SECONDS = 15 * 60;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
/** Attempts to enter a user code before a browser session is refused further tries. */
export const USER_CODE_ATTEMPT_LIMIT = 10;

export const DEVICE_CLIENT_ID = "coforge-computer";

export type DeviceAuthorizationStatus = "pending" | "approved" | "denied" | "consumed";

export type DeviceAuthorizationRecord = {
  id: string;
  userId: string | null;
  status: string;
  expiresAt: Date;
  lastPolledAt: Date | null;
};

/** The persistence this module needs, kept narrow so the state machine is testable without a
 * database and cannot reach for anything else. */
export interface DeviceAuthorizationStore {
  create(input: {
    deviceCodeHash: string;
    userCodeHash: string;
    expiresAt: Date;
  }): Promise<DeviceAuthorizationRecord>;
  findByDeviceCodeHash(hash: string): Promise<DeviceAuthorizationRecord | null>;
  findByUserCodeHash(hash: string): Promise<DeviceAuthorizationRecord | null>;
  markPolled(id: string, at: Date): Promise<void>;
  approve(id: string, userId: string, at: Date): Promise<void>;
  deny(id: string): Promise<void>;
  consume(id: string): Promise<void>;
}

/** Both secrets are looked up by digest, never stored in the clear: the device code is a bearer,
 * and the user code is short enough to be typed and therefore short enough to be guessed. SHA-256
 * without a salt is deliberate - lookup is by exact digest, and neither value is user-chosen,
 * low-entropy, or reused anywhere else. */
function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function generateUserCode(): string {
  let code = "";
  for (let index = 0; index < USER_CODE_LENGTH; index++) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return code;
}

export type AuthorizeResult = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresInSeconds: number;
  intervalSeconds: number;
};

export async function authorizeDevice(input: {
  store: DeviceAuthorizationStore;
  origin: string;
  now?: () => number;
}): Promise<AuthorizeResult> {
  const now = input.now?.() ?? Date.now();
  const deviceCode = randomBytes(32).toString("base64url");
  const userCode = generateUserCode();
  await input.store.create({
    deviceCodeHash: digest(deviceCode),
    userCodeHash: digest(userCode),
    expiresAt: new Date(now + DEVICE_CODE_TTL_SECONDS * 1000),
  });
  const formatted = formatUserCode(userCode);
  const verificationUri = `${input.origin}/oauth/verify`;
  return {
    deviceCode,
    userCode: formatted,
    verificationUri,
    verificationUriComplete: `${verificationUri}?user_code=${encodeURIComponent(formatted)}`,
    expiresInSeconds: DEVICE_CODE_TTL_SECONDS,
    intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
  };
}

export type PollOutcome =
  | { status: "authorized"; accessToken: string; expiresInSeconds: number }
  | {
      status: "error";
      error:
        | "authorization_pending"
        | "slow_down"
        | "expired_token"
        | "access_denied"
        | "invalid_grant";
    };

/**
 * One poll of the token endpoint. The error strings are exactly the ones
 * packages/computer/src/oauth-device-client.ts maps, and an unrecognized string there becomes an
 * opaque client-side failure - so these are a contract, not descriptive text.
 */
export async function pollDeviceToken(input: {
  store: DeviceAuthorizationStore;
  deviceCode: string;
  now?: () => number;
  environment?: Record<string, string | undefined>;
}): Promise<PollOutcome> {
  const now = input.now?.() ?? Date.now();
  const record = await input.store.findByDeviceCodeHash(digest(input.deviceCode));
  // An unknown device code and a consumed one are the same answer on purpose: a caller replaying
  // a code it already exchanged learns nothing about whether it once existed.
  if (!record || record.status === "consumed") return { status: "error", error: "invalid_grant" };
  if (record.expiresAt.getTime() <= now) return { status: "error", error: "expired_token" };
  if (record.status === "denied") return { status: "error", error: "access_denied" };

  // Polling faster than the advertised interval earns `slow_down` rather than an answer. Checked
  // before the pending branch so an impatient client is told to back off even while it waits.
  const lastPolled = record.lastPolledAt?.getTime();
  const tooSoon =
    lastPolled !== undefined && now - lastPolled < DEVICE_POLL_INTERVAL_SECONDS * 1000;
  await input.store.markPolled(record.id, new Date(now));
  if (tooSoon) return { status: "error", error: "slow_down" };

  if (record.status !== "approved" || !record.userId)
    return { status: "error", error: "authorization_pending" };

  // Consume before minting: a device code is single-use, and marking it first means a concurrent
  // second poll cannot also be handed a token.
  await input.store.consume(record.id);
  const { token, expiresInSeconds } = await signComputerAccessToken(
    record.userId,
    input.environment,
  );
  return { status: "authorized", accessToken: token, expiresInSeconds };
}

export type UserCodeLookup =
  | { found: true; id: string; expiresAt: Date }
  | { found: false; reason: "unknown" | "expired" | "settled" };

/** Resolves a typed code for the approval page, without disclosing more than whether it is
 * actionable. */
export async function lookupUserCode(input: {
  store: DeviceAuthorizationStore;
  userCode: string;
  now?: () => number;
}): Promise<UserCodeLookup> {
  const now = input.now?.() ?? Date.now();
  const normalized = normalizeUserCode(input.userCode);
  if (normalized.length !== USER_CODE_LENGTH) return { found: false, reason: "unknown" };
  const record = await input.store.findByUserCodeHash(digest(normalized));
  if (!record) return { found: false, reason: "unknown" };
  if (record.expiresAt.getTime() <= now) return { found: false, reason: "expired" };
  if (record.status !== "pending") return { found: false, reason: "settled" };
  return { found: true, id: record.id, expiresAt: record.expiresAt };
}

export async function approveUserCode(input: {
  store: DeviceAuthorizationStore;
  userCode: string;
  userId: string;
  now?: () => number;
}): Promise<UserCodeLookup> {
  const lookup = await lookupUserCode(input);
  if (!lookup.found) return lookup;
  await input.store.approve(lookup.id, input.userId, new Date(input.now?.() ?? Date.now()));
  return lookup;
}

export async function denyUserCode(input: {
  store: DeviceAuthorizationStore;
  userCode: string;
  now?: () => number;
}): Promise<UserCodeLookup> {
  const lookup = await lookupUserCode(input);
  if (!lookup.found) return lookup;
  await input.store.deny(lookup.id);
  return lookup;
}
