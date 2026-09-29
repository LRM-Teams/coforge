import { expect, test } from "bun:test";
import { getLogger } from "@logtape/logtape";
import { captureDaemonLogs } from "./log-capture";

const logger = getLogger(["coforge", "daemon", "log-capture-test"]);

function events(records: readonly { properties: Record<string, unknown> }[]): unknown[] {
  return records.map((record) => record.properties.event);
}

/** A capture whose test timed out keeps running, so its end arrives while a later test's capture
 * is open. That late end, and whatever the abandoned work still logs, must stay in its own
 * capture. */
test("a capture that ends late does not disturb the capture opened after it", async () => {
  const firstOpen = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const first = captureDaemonLogs(async () => {
    logger.info("first opened", { event: "first:opened" });
    firstOpen.resolve();
    await releaseFirst.promise;
    logger.info("first finished late", { event: "first:late" });
  });
  await firstOpen.promise;

  const second = await captureDaemonLogs(async () => {
    logger.info("second opened", { event: "second:opened" });
    releaseFirst.resolve();
    await first;
    logger.info("second continued", { event: "second:continued" });
  });

  expect(events(second.records)).toEqual(["second:opened", "second:continued"]);
  expect(events((await first).records)).toEqual(["first:opened", "first:late"]);
});

/** Child-process output and exit continuations are how the provider fixtures reach the logger. */
test("records logged after a child process exits still reach the capture that started it", async () => {
  const childOpen = Promise.withResolvers<void>();
  const other = Promise.withResolvers<void>();
  const child = captureDaemonLogs(async () => {
    const subprocess = Bun.spawn([process.execPath, "-e", "console.log('done')"], {
      stdout: "pipe",
    });
    childOpen.resolve();
    await other.promise;
    expect(await new Response(subprocess.stdout).text()).toBe("done\n");
    await subprocess.exited;
    logger.info("child exited", { event: "child:exited" });
  });

  await childOpen.promise;

  const unrelated = await captureDaemonLogs(async () => {
    logger.info("unrelated", { event: "unrelated" });
    other.resolve();
    await child;
  });

  expect(events((await child).records)).toEqual(["child:exited"]);
  expect(events(unrelated.records)).toEqual(["unrelated"]);
});

test("a failing run rethrows and leaves later captures working", async () => {
  await expect(
    captureDaemonLogs(async () => {
      throw new Error("run failed");
    }),
  ).rejects.toThrow("run failed");

  const { records } = await captureDaemonLogs(async () => {
    logger.info("after failure", { event: "after:failure" });
  });
  expect(events(records)).toEqual(["after:failure"]);
});
