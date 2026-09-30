import { expect, test } from "bun:test";
import { tmpdir } from "node:os";

import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { AntigravityProvider } from "#src/code-agent/antigravity/provider";
import { readAntigravityUsage } from "#src/code-agent/antigravity/usage";
import { UsageUnavailableError, UsageUnsupportedError } from "#src/code-agent/contract";
import { ANTIGRAVITY_USAGE_BUDGET_MS as USAGE_BUDGET_MS } from "./catalog-discovery-budget";

const FIXTURE = new URL("./fixtures/antigravity-models-fixture.ts", import.meta.url).pathname;

function readUsage(environment: Record<string, string> = {}) {
  return readAntigravityUsage(tmpdir(), {
    command: [process.execPath, FIXTURE],
    environment,
  });
}

function usageOutput(groups: unknown[], status = "SUCCESS"): string {
  return JSON.stringify({ status, command: { name: "usage", data: { groups } } });
}

test(
  "the real /usage capture reports the tightest group's 5-hour and weekly windows",
  async () => {
    // Captured from agy 1.2.13: Gemini has 98.8% of its 5-hour and 99.5% of its weekly quota
    // left, Claude and GPT models 100% of both, so the Gemini group is the one to show.
    const snapshot = await readUsage();
    expect(snapshot?.provider).toBe(RUNTIME_PROVIDER.ANTIGRAVITY);
    expect(snapshot?.health).toBe("ok");
    // agy's group names ("Gemini Models") are not plans, so no plan is reported.
    expect(snapshot?.planType).toBeUndefined();
    expect(snapshot?.primary).toMatchObject({
      id: "antigravity-gemini-5h",
      status: "ok",
      windowDurationMinutes: 300,
      usedPercent: 1.24,
      resetsAt: "2026-09-30T08:17:14.000Z",
    });
    expect(snapshot?.secondary).toMatchObject({
      id: "antigravity-gemini-weekly",
      status: "ok",
      windowDurationMinutes: 10_080,
      usedPercent: 0.52,
      resetsAt: "2026-10-05T01:34:48.000Z",
    });
  },
  USAGE_BUDGET_MS,
);

test(
  "an exhausted bucket marks its window limit_reached and the account rate-limited",
  async () => {
    const snapshot = await readUsage({
      COFORGE_ANTIGRAVITY_USAGE_OUTPUT: usageOutput([
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-5h",
              window: "5h",
              remaining_fraction: 0.4,
              reset_time: "2026-09-30T08:00:00Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              window: "weekly",
              remaining_fraction: 0.9,
              reset_time: "2026-10-07T00:00:00Z",
            },
            {
              id: "3p-5h",
              window: "5h",
              remaining_fraction: 0,
              reset_time: "2026-09-30T11:00:00Z",
            },
          ],
        },
      ]),
    });
    expect(snapshot?.health).toBe("rate_limited");
    expect(snapshot?.primary).toMatchObject({
      id: "antigravity-3p-5h",
      usedPercent: 100,
      status: "limit_reached",
    });
    expect(snapshot?.secondary).toMatchObject({ id: "antigravity-3p-weekly", usedPercent: 10 });
  },
  USAGE_BUDGET_MS,
);

test(
  "a wrapper banner printed ahead of the JSON answer is skipped",
  async () => {
    const snapshot = await readUsage({
      COFORGE_ANTIGRAVITY_USAGE_OUTPUT: `[wrapper] starting agy\n${usageOutput([
        {
          name: "Gemini Models",
          buckets: [{ id: "gemini-5h", window: "5h", remaining_fraction: 0.5 }],
        },
      ])}\n`,
    });
    expect(snapshot?.primary?.usedPercent).toBe(50);
  },
  USAGE_BUDGET_MS,
);

test(
  "a signed-out agy is usage unavailable, not a failed scan",
  async () => {
    // Assumed shape: a signed-out /usage answer was not captured, so this stands in for any
    // error that names sign-in or auth.
    await expect(
      readUsage({
        COFORGE_ANTIGRAVITY_USAGE_OUTPUT: JSON.stringify({
          status: "ERROR",
          error: "not signed in: run agy to sign in",
        }),
        COFORGE_ANTIGRAVITY_USAGE_EXIT: "1",
      }),
    ).rejects.toBeInstanceOf(UsageUnavailableError);
  },
  USAGE_BUDGET_MS,
);

test(
  "an answer that is not JSON is a failed scan that names the exit code, not a signed-out account",
  async () => {
    const read = readUsage({
      COFORGE_ANTIGRAVITY_USAGE_OUTPUT: "panic: runtime error\n",
      COFORGE_ANTIGRAVITY_USAGE_EXIT: "2",
    });
    await expect(read).rejects.not.toBeInstanceOf(UsageUnavailableError);
    await expect(read).rejects.toThrow("agy /usage exited 2 without a JSON answer");
  },
  USAGE_BUDGET_MS,
);

test(
  "a /usage answer with no quota groups is unsupported",
  async () => {
    await expect(
      readUsage({ COFORGE_ANTIGRAVITY_USAGE_OUTPUT: usageOutput([]) }),
    ).rejects.toBeInstanceOf(UsageUnsupportedError);
  },
  USAGE_BUDGET_MS,
);

test(
  "SSH session markers never reach the /usage read",
  async () => {
    // The fixture exits 1 if any marker leaks, which would leave no snapshot.
    const snapshot = await readUsage({ SSH_CLIENT: "10.0.0.1 1 22", SSH_TTY: "/dev/ttys001" });
    expect(snapshot?.primary).toBeDefined();
  },
  USAGE_BUDGET_MS,
);

test(
  "the provider reads usage through its own agy command",
  async () => {
    const snapshot = await new AntigravityProvider({
      command: [process.execPath, FIXTURE],
    }).readUsage({ workingDirectory: tmpdir() });
    expect(snapshot?.primary?.id).toBe("antigravity-gemini-5h");
  },
  USAGE_BUDGET_MS,
);
