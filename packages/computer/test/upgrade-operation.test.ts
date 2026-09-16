import { expect, test } from "bun:test";

import { parseRemoteUpgradeOperation } from "../src/release/upgrade-operation";

const id = "4bd9b3f0-6f2d-4f4a-9d3e-0f1b2c3d4e5f";

test("a remote upgrade operation is built from argv alone", () => {
  expect(
    parseRemoteUpgradeOperation([
      "__remote-upgrade",
      "--request-id",
      id,
      "--version",
      "0.1.0-dev.29",
    ]),
  ).toEqual({
    requestId: id,
    operation: "upgrade",
    selection: "0.1.0-dev.29",
    origin: "remote",
    quiet: true,
  });
});

test("a remote upgrade operation ignores the retired environment handoff", () => {
  const other = "11111111-2222-4333-8444-555555555555";
  const previous = {
    request: Bun.env.COFORGE_UPGRADE_REQUEST_ID,
    version: Bun.env.COFORGE_UPGRADE_VERSION,
  };
  Bun.env.COFORGE_UPGRADE_REQUEST_ID = other;
  Bun.env.COFORGE_UPGRADE_VERSION = "9.9.9";
  try {
    const operation = parseRemoteUpgradeOperation([
      "__remote-upgrade",
      "--request-id",
      id,
      "--version",
      "0.1.0-dev.29",
    ]);
    expect(operation.requestId).toBe(id);
    expect(operation.selection).toBe("0.1.0-dev.29");
  } finally {
    if (previous.request === undefined) delete Bun.env.COFORGE_UPGRADE_REQUEST_ID;
    else Bun.env.COFORGE_UPGRADE_REQUEST_ID = previous.request;
    if (previous.version === undefined) delete Bun.env.COFORGE_UPGRADE_VERSION;
    else Bun.env.COFORGE_UPGRADE_VERSION = previous.version;
  }
});

test.each([
  [["__remote-upgrade", "--version", "1.0.0"], "valid UUID request ID"],
  [["__remote-upgrade", "--request-id", "not-a-uuid", "--version", "1.0.0"], "valid UUID"],
  [["__remote-upgrade", "--request-id", id], "--version"],
])("a remote upgrade operation rejects %p", (argv, message) => {
  expect(() => parseRemoteUpgradeOperation(argv)).toThrow(message);
});

test("the source tree no longer carries an upgrade environment handoff", async () => {
  const sources = new Bun.Glob("**/*.ts");
  const root = new URL("../src/", import.meta.url).pathname;
  const offenders: string[] = [];
  for await (const relative of sources.scan(root)) {
    const text = await Bun.file(`${root}${relative}`).text();
    if (text.includes("COFORGE_UPGRADE_REQUEST_ID") || text.includes("COFORGE_UPGRADE_VERSION"))
      offenders.push(relative);
  }
  expect(offenders).toEqual([]);
});
