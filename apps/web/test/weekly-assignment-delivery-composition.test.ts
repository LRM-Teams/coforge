import { expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";

import { tryCreateWeeklyAssignmentDelivery } from "@/server/records/weekly-assignment-delivery-composition.server";

test("weekly assignment channel delivery is skipped when Centrifugo is not configured", () => {
  const db = {} as PrismaClient;
  expect(
    tryCreateWeeklyAssignmentDelivery(db, {
      COFORGE_CENTRIFUGO_API_URL: "",
      COFORGE_CENTRIFUGO_API_KEY: "",
    }),
  ).toBeUndefined();
  expect(tryCreateWeeklyAssignmentDelivery(db, {})).toBeUndefined();
});

test("weekly assignment channel delivery is created when Centrifugo env is present", () => {
  const db = {} as PrismaClient;
  const delivery = tryCreateWeeklyAssignmentDelivery(db, {
    COFORGE_CENTRIFUGO_API_URL: "http://centrifugo.test/api",
    COFORGE_CENTRIFUGO_API_KEY: "test-key",
  });
  expect(delivery).toBeDefined();
  expect(typeof delivery?.notifyChannel).toBe("function");
});
