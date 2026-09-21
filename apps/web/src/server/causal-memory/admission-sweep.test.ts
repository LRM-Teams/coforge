import { expect, test } from "bun:test";
import { CausalAdmissionSweep, type CausalAdmissionSweepLock } from "./admission-sweep.server";

test("the Redis lock keeps a second sweeper from ingesting in the same window", async () => {
  let held = false;
  const lock: CausalAdmissionSweepLock = {
    async acquire() {
      if (held) return false;
      held = true;
      return true;
    },
  };
  const listEnabledTenants = async () => {
    calls += 1;
    return [];
  };
  let calls = 0;
  const db = { causalWorkspaceTenant: { findMany: listEnabledTenants } };
  const sweepA = new CausalAdmissionSweep(db as never, lock);
  const sweepB = new CausalAdmissionSweep(db as never, lock);
  await sweepA.tick();
  await sweepB.tick();
  expect(calls).toBe(1);
});
