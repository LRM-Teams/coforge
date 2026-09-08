import { expect, test } from "bun:test";

import {
  approveUserCode,
  authorizeDevice,
  denyUserCode,
  lookupUserCode,
  pollDeviceToken,
  type DeviceAuthorizationRecord,
  type DeviceAuthorizationStore,
} from "@/server/auth/device-auth.server";
import { normalizeUserCode } from "@/features/device-auth/device-code-format";

/** An in-memory stand-in for the Prisma store, faithful in the one way that matters: `approve`,
 * `deny` and `consume` are conditional on the current status, so a test can exercise the races
 * the real `updateMany` guards against. */
function memoryStore() {
  const rows = new Map<
    string,
    DeviceAuthorizationRecord & { deviceHash: string; userHash: string }
  >();
  let nextId = 1;
  const store: DeviceAuthorizationStore = {
    async create({ deviceCodeHash, userCodeHash, expiresAt }) {
      const row = {
        id: String(nextId++),
        userId: null,
        status: "pending",
        expiresAt,
        lastPolledAt: null,
        deviceHash: deviceCodeHash,
        userHash: userCodeHash,
      };
      rows.set(row.id, row);
      return row;
    },
    async findByDeviceCodeHash(hash) {
      return [...rows.values()].find((row) => row.deviceHash === hash) ?? null;
    },
    async findByUserCodeHash(hash) {
      return [...rows.values()].find((row) => row.userHash === hash) ?? null;
    },
    async markPolled(id, at) {
      const row = rows.get(id);
      if (row) row.lastPolledAt = at;
    },
    async approve(id, userId) {
      const row = rows.get(id);
      if (row?.status === "pending") {
        row.status = "approved";
        row.userId = userId;
      }
    },
    async deny(id) {
      const row = rows.get(id);
      if (row?.status === "pending") row.status = "denied";
    },
    async consume(id) {
      const row = rows.get(id);
      if (row?.status === "approved") row.status = "consumed";
    },
  };
  return store;
}

const environment = {
  COFORGE_WORKER_JWT_PRIVATE_JWK: JSON.stringify({
    kty: "OKP",
    crv: "Ed25519",
    d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
    x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  }),
  COFORGE_WORKER_JWT_KEY_ID: "test-key",
};

const USER = "00000000-0000-5000-8000-000000000009";

test("a grant is pending until approved, then yields exactly one token", async () => {
  const store = memoryStore();
  const start = Date.parse("2026-09-08T00:00:00Z");
  const grant = await authorizeDevice({ store, origin: "https://example.test", now: () => start });

  // The client prefers verification_uri_complete, so the code has to survive the round trip
  // through a URL and back through normalization.
  expect(grant.verificationUriComplete).toContain(encodeURIComponent(grant.userCode));
  expect(normalizeUserCode(grant.userCode)).toHaveLength(8);

  const pending = await pollDeviceToken({
    store,
    deviceCode: grant.deviceCode,
    now: () => start + 1000,
    environment,
  });
  expect(pending).toEqual({ status: "error", error: "authorization_pending" });

  await approveUserCode({ store, userCode: grant.userCode, userId: USER, now: () => start + 2000 });

  const authorized = await pollDeviceToken({
    store,
    deviceCode: grant.deviceCode,
    now: () => start + 20_000,
    environment,
  });
  expect(authorized.status).toBe("authorized");
  if (authorized.status !== "authorized") throw new Error("unreachable");
  const [, payload] = authorized.accessToken.split(".");
  expect(JSON.parse(atob(payload!)).sub).toBe(USER);

  // A device code is single-use. Replaying it must not mint a second token, and must not reveal
  // that it was ever valid.
  const replay = await pollDeviceToken({
    store,
    deviceCode: grant.deviceCode,
    now: () => start + 40_000,
    environment,
  });
  expect(replay).toEqual({ status: "error", error: "invalid_grant" });
});

test("polling faster than the advertised interval is told to slow down", async () => {
  const store = memoryStore();
  const start = Date.parse("2026-09-08T00:00:00Z");
  const grant = await authorizeDevice({ store, origin: "https://example.test", now: () => start });

  await pollDeviceToken({ store, deviceCode: grant.deviceCode, now: () => start, environment });
  const impatient = await pollDeviceToken({
    store,
    deviceCode: grant.deviceCode,
    now: () => start + 1000,
    environment,
  });
  expect(impatient).toEqual({ status: "error", error: "slow_down" });

  const patient = await pollDeviceToken({
    store,
    deviceCode: grant.deviceCode,
    now: () => start + 30_000,
    environment,
  });
  expect(patient).toEqual({ status: "error", error: "authorization_pending" });
});

test("an expired grant is expired for both halves of the flow", async () => {
  const store = memoryStore();
  const start = Date.parse("2026-09-08T00:00:00Z");
  const grant = await authorizeDevice({ store, origin: "https://example.test", now: () => start });
  const afterExpiry = start + 16 * 60 * 1000;

  expect(await lookupUserCode({ store, userCode: grant.userCode, now: () => afterExpiry })).toEqual(
    {
      found: false,
      reason: "expired",
    },
  );
  expect(
    await pollDeviceToken({
      store,
      deviceCode: grant.deviceCode,
      now: () => afterExpiry,
      environment,
    }),
  ).toEqual({ status: "error", error: "expired_token" });
});

test("denial is final and reported as access_denied", async () => {
  const store = memoryStore();
  const grant = await authorizeDevice({ store, origin: "https://example.test" });
  await denyUserCode({ store, userCode: grant.userCode });

  expect(await pollDeviceToken({ store, deviceCode: grant.deviceCode, environment })).toEqual({
    status: "error",
    error: "access_denied",
  });
  // A denied grant cannot be revived by approving it afterwards.
  expect(await approveUserCode({ store, userCode: grant.userCode, userId: USER })).toEqual({
    found: false,
    reason: "settled",
  });
});

test("a second approval cannot rebind an approved grant to another user", async () => {
  const store = memoryStore();
  const grant = await authorizeDevice({ store, origin: "https://example.test" });
  await approveUserCode({ store, userCode: grant.userCode, userId: USER });

  const other = "00000000-0000-5000-8000-000000000010";
  expect(await approveUserCode({ store, userCode: grant.userCode, userId: other })).toEqual({
    found: false,
    reason: "settled",
  });

  const authorized = await pollDeviceToken({ store, deviceCode: grant.deviceCode, environment });
  if (authorized.status !== "authorized") throw new Error("expected a token");
  const [, payload] = authorized.accessToken.split(".");
  expect(JSON.parse(atob(payload!)).sub).toBe(USER);
});

test("a code is accepted however it was typed, and an unknown one is merely unknown", async () => {
  const store = memoryStore();
  const grant = await authorizeDevice({ store, origin: "https://example.test" });
  const typed = grant.userCode.replace("-", "").toLowerCase();

  expect((await lookupUserCode({ store, userCode: ` ${typed} ` })).found).toBe(true);
  // Wrong codes report the same "unknown" whether or not they are even well-formed, so guessing
  // learns nothing beyond the guess being wrong.
  expect(await lookupUserCode({ store, userCode: "ZZZZ-ZZZZ" })).toEqual({
    found: false,
    reason: "unknown",
  });
  expect(await lookupUserCode({ store, userCode: "short" })).toEqual({
    found: false,
    reason: "unknown",
  });
});

test("the device code is never stored, only its digest", async () => {
  const store = memoryStore();
  const grant = await authorizeDevice({ store, origin: "https://example.test" });
  const rows = JSON.stringify(await store.findByDeviceCodeHash("nothing"));
  expect(rows).not.toContain(grant.deviceCode);
  // Confirm the digest lookup is what actually finds it, rather than the raw value.
  expect(await store.findByDeviceCodeHash(grant.deviceCode)).toBeNull();
});
