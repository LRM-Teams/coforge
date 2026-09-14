import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Compilation is platform-independent even though launchd execution is not.
test("macOS lifecycle fixture links the current provider graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-mac-build-"));
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/build-macos-computer.ts"),
        join(root, process.platform === "win32" ? "computer.exe" : "computer"),
        "http://127.0.0.1:1",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
