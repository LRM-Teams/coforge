import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readKiroUsage } from "../src/code-agent/kiro/usage";
import { UsageUnavailableError } from "../src/code-agent/contract";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function credentials(region = "us-east-1") {
  const directory = await mkdtemp(join(tmpdir(), "coforge-kiro-usage-"));
  directories.push(directory);
  const path = join(directory, "data.sqlite3");
  const db = new Database(path);
  db.exec(
    "CREATE TABLE auth_kv(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE state(key TEXT PRIMARY KEY, value TEXT)",
  );
  db.query("INSERT INTO auth_kv VALUES (?, ?)").run(
    "kirocli:odic:token",
    JSON.stringify({
      access_token: "fixture-access",
      refresh_token: "fixture-refresh",
      expires_at: "2099-01-01T00:00:00Z",
    }),
  );
  const arn = `arn:aws:codewhisperer:${region}:123456789012:profile/test`;
  db.query("INSERT INTO state VALUES (?, ?)").run(
    "api.codewhisperer.profile",
    JSON.stringify({ arn }),
  );
  db.close();
  return { directory, path, arn };
}

const payload = {
  subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
  nextDateReset: 1790812800,
  usageBreakdownList: [
    {
      resourceType: "CREDIT",
      currentUsageWithPrecision: 75,
      usageLimitWithPrecision: 200,
      currentOveragesWithPrecision: 15,
    },
  ],
};

test("reads the current Kiro account without modifying credentials and excludes overage from monthly quota", async () => {
  const fixture = await credentials();
  const before = await Bun.file(fixture.path).arrayBuffer();
  let calls = 0;
  const result = await readKiroUsage({
    environment: { KIRO_DATA_DIR: fixture.directory },
    fetch: async (url, init) => {
      calls++;
      expect(String(url)).toBe("https://codewhisperer.us-east-1.amazonaws.com/");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-access");
      expect(new Headers(init?.headers).get("X-Amz-Target")).toBe(
        "AmazonCodeWhispererService.GetUsageLimits",
      );
      expect(JSON.parse(String(init?.body))).toEqual({ profileArn: fixture.arn });
      return Response.json(payload);
    },
  });
  expect(calls).toBe(1);
  expect(result).toEqual({
    provider: "kiro",
    planType: "KIRO PRO",
    creditUsage: { used: 60, limit: 200, overage: 15 },
    primary: {
      usedPercent: 30,
      windowDurationMinutes: 43200,
      resetsAt: "2026-10-01T00:00:00.000Z",
    },
  });
  expect(await Bun.file(fixture.path).arrayBuffer()).toEqual(before);
  expect(JSON.stringify(result)).not.toContain("fixture-");
});

test("uses the fixed European endpoint and the credit-specific reset", async () => {
  const fixture = await credentials("eu-central-1");
  const result = await readKiroUsage({
    environment: { KIRO_DATA_DIR: fixture.directory },
    fetch: async (url) => {
      expect(url).toBe("https://q.eu-central-1.amazonaws.com/");
      return Response.json({
        ...payload,
        usageBreakdownList: [
          {
            ...payload.usageBreakdownList[0],
            nextDateReset: 1793491200,
            currentUsageWithPrecision: 0,
            currentOveragesWithPrecision: 0,
          },
        ],
      });
    },
  });
  expect(result?.primary).toEqual({
    usedPercent: 0,
    windowDurationMinutes: 44640,
    resetsAt: "2026-11-01T00:00:00.000Z",
  });
});

test("never sends credentials for expired tokens or unsupported profile identities", async () => {
  const fixture = await credentials();
  const db = new Database(fixture.path);
  try {
    for (const [key, value, table] of [
      [
        "kirocli:odic:token",
        { access_token: "fixture-access", expires_at: "2020-01-01T00:00:00Z" },
        "auth_kv",
      ],
      ["kirocli:odic:token", { access_token: "fixture-access", expires_at: "bad-date" }, "auth_kv"],
      [
        "api.codewhisperer.profile",
        { arn: "arn:aws:codewhisperer:evil.example:123456789012:profile/test" },
        "state",
      ],
      ["api.codewhisperer.profile", { arn: fixture.arn + "\n" }, "state"],
    ] as const) {
      db.query("UPDATE auth_kv SET value = ?").run(
        JSON.stringify({ access_token: "fixture-access" }),
      );
      db.query(`UPDATE ${table} SET value = ? WHERE key = ?`).run(JSON.stringify(value), key);
      let calls = 0;
      expect(
        await readKiroUsage({
          environment: { KIRO_DATA_DIR: fixture.directory },
          fetch: async () => {
            calls++;
            return Response.json(payload);
          },
        }),
      ).toBeNull();
      expect(calls).toBe(0);
    }
  } finally {
    db.close();
  }
});

test("does not invent quota from bonuses, trials, invalid numbers or millisecond resets", async () => {
  const fixture = await credentials();
  for (const changes of [
    { bonuses: [{}] },
    { freeTrialInfo: { freeTrialStatus: "ACTIVE" } },
    { currentUsageWithPrecision: -1 },
    { usageLimitWithPrecision: 0 },
    { currentUsageWithPrecision: 10, currentOveragesWithPrecision: 15 },
    { currentUsageWithPrecision: 300 },
    { nextDateReset: 1790812800000 },
  ]) {
    await expect(
      readKiroUsage({
        environment: { KIRO_DATA_DIR: fixture.directory },
        fetch: async () =>
          Response.json({
            ...payload,
            usageBreakdownList: [{ ...payload.usageBreakdownList[0], ...changes }],
          }),
      }),
    ).rejects.toBeInstanceOf(UsageUnavailableError);
  }
});

test("auth rejection is unavailable, transport failure is sanitized, and neither retries", async () => {
  const fixture = await credentials();
  for (const status of [401, 403]) {
    let calls = 0;
    expect(
      await readKiroUsage({
        environment: { KIRO_DATA_DIR: fixture.directory },
        fetch: async () => {
          calls++;
          return new Response("fixture-secret", { status });
        },
      }),
    ).toBeNull();
    expect(calls).toBe(1);
  }
  await expect(
    readKiroUsage({
      environment: { KIRO_DATA_DIR: fixture.directory },
      fetch: async () => {
        throw new Error("fixture-secret Authorization");
      },
    }),
  ).rejects.toThrow("Kiro usage request failed");
});
