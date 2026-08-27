import { expect, test } from "bun:test";
import { tmpdir } from "node:os";

import { JsonlProcess } from "../src/code-agent/jsonl-process";

test("invalid child output permanently fails current and future requests", async () => {
  const child = new JsonlProcess(
    [globalThis.process.execPath, new URL("./fixtures/invalid-jsonl.ts", import.meta.url).pathname],
    tmpdir(),
    { PATH: globalThis.process.env.PATH ?? "" },
  );

  try {
    await Bun.sleep(20);
    await expect(child.request({ method: "after-invalid-output" })).rejects.toThrow(
      "invalid output",
    );
    await expect(child.request({ method: "still-failed" })).rejects.toThrow("invalid output");
  } finally {
    await child.dispose();
  }
});
