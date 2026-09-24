import { afterEach, expect, test } from "bun:test";
import { readLatestComputerVersion } from "#src/features/computers/computers.functions";

/** The version cache is a module global, so every case drives it through the exported seam with
 * an explicitly injected clock. The clock only ever moves forward (the cache keys on `now - at`),
 * and afterEach jumps it far past every TTL and re-stamps it with a miss: every later test then
 * starts from a fetch, never from a previous test's cached answer. */
let nowMs = 1_000_000;
const now = () => nowMs;

function fakeFetch(
  response: { ok: true; body: string } | { ok: false; body: string } | "network-error",
  calls: string[],
) {
  return (async (input: unknown) => {
    calls.push(String(input));
    if (response === "network-error") throw new Error("feed down");
    return new Response(response.body, { status: response.ok ? 200 : 503 });
  }) as unknown as typeof fetch;
}

afterEach(async () => {
  // Jump the shared clock past every TTL and stamp the cache as an expired miss, so every
  // later test starts from a fetch rather than a previous test's cached answer.
  nowMs += 10_000_000;
  await readLatestComputerVersion("https://reset.test", fakeFetch("network-error", []), now);
});

test("first read fetches the feed, later reads within the TTL reuse the answer", async () => {
  const calls: string[] = [];
  const fetchImpl = fakeFetch({ ok: true, body: "1.2.3\n" }, calls);
  expect(await readLatestComputerVersion("https://feed.test", fetchImpl, now)).toBe("1.2.3");
  expect(calls).toHaveLength(1);
  expect(await readLatestComputerVersion("https://feed.test", fetchImpl, now)).toBe("1.2.3");
  expect(calls).toHaveLength(1);
  // Past the TTL the next read fetches again — and picks up a new release.
  nowMs += 60_000 + 1;
  const next = fakeFetch({ ok: true, body: "1.3.0\n" }, calls);
  expect(await readLatestComputerVersion("https://feed.test", next, now)).toBe("1.3.0");
  expect(calls).toHaveLength(2);
});

test("a failed feed read is cached only briefly, so the next window retries", async () => {
  const fetchImpl = fakeFetch({ ok: false, body: "" }, []);
  expect(await readLatestComputerVersion("https://feed.test", fetchImpl, now)).toBeNull();
  expect(await readLatestComputerVersion("https://feed.test", fetchImpl, now)).toBeNull();
  // The failure window is short: one second past it, the read retries (and may succeed).
  nowMs += 10_000 + 1;
  const recovered = fakeFetch({ ok: true, body: "2.0.0\n" }, []);
  expect(await readLatestComputerVersion("https://feed.test", recovered, now)).toBe("2.0.0");
});

test("an unparsable body is a miss, not a bad version", async () => {
  const fetchImpl = fakeFetch({ ok: true, body: "not a version\n" }, []);
  expect(await readLatestComputerVersion("https://feed.test", fetchImpl, now)).toBeNull();
  // Within the failure window the miss is reused, not re-fetched.
  expect(await readLatestComputerVersion("https://feed.test", fetchImpl, now)).toBeNull();
});
