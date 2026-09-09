import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { LaunchdProcessOwner } from "../src/platform/launchd-process";
import { stopLaunchdJobs } from "../src/platform/launchd-job";
import { readLines } from "./fixtures/read-lines";

test.skipIf(process.platform !== "darwin")(
  "native stop lets the provider handle SIGTERM before cleanup",
  async () => {
    const root = await mkdtemp("/private/tmp/coforge-agent-test-");
    const owner = new LaunchdProcessOwner({
      directory: root,
      prefix: `cn.coforge.agent.${"c".repeat(24)}.`,
      runner: [process.execPath, `${import.meta.dir}/fixtures/launchd-agent-runner.ts`],
    });
    const tree = owner.spawn(
      [
        "/bin/sh",
        "-c",
        "trap 'echo terminated; exit 0' TERM; echo ready; while :; do sleep 1; done",
      ],
      root,
      { PATH: "/usr/bin:/bin" },
    );
    try {
      const reader = readLines(tree.child.stdout);
      expect((await reader.next()).value).toBe("ready\n");
      const terminated = reader.next();
      await tree.terminate(false);
      expect((await terminated).value).toBe("terminated\n");
      expect(await tree.waitForExit(5000)).toBe(true);
    } finally {
      await tree.terminate(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);

test.skipIf(process.platform !== "darwin")(
  "Agent native root exits when its Workspace owner is killed",
  async () => {
    const root = await mkdtemp("/private/tmp/coforge-agent-test-");
    const prefix = `cn.coforge.agent.${new Bun.CryptoHasher("sha256").update(root).digest("hex").slice(0, 24)}.`;
    const parent = Bun.spawn(
      [process.execPath, `${import.meta.dir}/fixtures/launchd-agent-parent.ts`, root, prefix],
      { stdout: "pipe", stderr: "inherit" },
    );
    try {
      const first = await readLines(parent.stdout).next();
      const pid = Number(first.value?.trim());
      expect(pid).toBeGreaterThan(0);
      parent.kill("SIGKILL");
      await parent.exited;
      const deadline = Date.now() + 5000;
      while (true) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        if (Date.now() >= deadline) throw new Error("Agent survived Workspace death");
        await Bun.sleep(20);
      }
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      parent.kill("SIGKILL");
      await parent.exited;
      await stopLaunchdJobs(prefix, root);
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);

test.skipIf(process.platform !== "darwin")(
  "native Agent job preserves stdio and cleans up independently",
  async () => {
    const root = await mkdtemp("/private/tmp/coforge-agent-test-");
    const owner = new LaunchdProcessOwner({
      directory: root,
      prefix: `cn.coforge.agent.${"a".repeat(24)}.`,
      runner: [process.execPath, `${import.meta.dir}/fixtures/launchd-agent-runner.ts`],
    });
    const tree = owner.spawn(["/bin/cat"], root, { PATH: "/usr/bin:/bin" });
    try {
      const next = readLines(tree.child.stdout).next();
      tree.child.stdin.write("hello native job\n");
      await tree.child.stdin.flush();
      expect((await next).value).toBe("hello native job\n");
      await tree.terminate(false);
      expect(await tree.waitForExit(5000)).toBe(true);
      await tree.child.exited;
    } finally {
      await tree.terminate(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);

test.skipIf(process.platform !== "darwin")(
  "stopping one Agent cleans its descendants without stopping its peer",
  async () => {
    const root = await mkdtemp("/private/tmp/coforge-agent-test-");
    const owner = new LaunchdProcessOwner({
      directory: root,
      prefix: `cn.coforge.agent.${"b".repeat(24)}.`,
      runner: [process.execPath, `${import.meta.dir}/fixtures/launchd-agent-runner.ts`],
    });
    const tree = owner.spawn(["/bin/sh", "-c", "sleep 300 & echo $!; wait"], root, {
      PATH: "/usr/bin:/bin",
    });
    const peer = owner.spawn(["/bin/cat"], root, { PATH: "/usr/bin:/bin" });
    try {
      const first = await readLines(tree.child.stdout).next();
      const descendant = Number(first.value?.trim());
      expect(descendant).toBeGreaterThan(0);
      await tree.terminate(false);
      expect(await tree.waitForExit(5000)).toBe(true);
      expect(() => process.kill(descendant, 0)).toThrow();
      const next = readLines(peer.child.stdout).next();
      peer.child.stdin.write("peer alive\n");
      await peer.child.stdin.flush();
      expect((await next).value).toBe("peer alive\n");
    } finally {
      await tree.terminate(true);
      await peer.terminate(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
