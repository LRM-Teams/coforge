import { expect, test } from "bun:test";
import { selectChecks } from "./selection";

test("a Web-only PR does not run client or infrastructure checks", () => {
  expect(selectChecks(["apps/web/src/features/tasks/task-board.tsx"], "changes")).toEqual(["web"]);
});

test("dependency changes include downstream consumers, but not unrelated modules", () => {
  expect(selectChecks(["packages/daemon/src/runtime.ts"], "changes")).toEqual([
    "computer",
    "daemon",
    "macos-lifecycle",
    "windows-release",
  ]);
  expect(selectChecks(["packages/cli/src/cli.ts"], "changes")).toEqual([
    "cli",
    "computer",
    "daemon",
    "macos-lifecycle",
    "windows-release",
  ]);
  expect(selectChecks(["packages/agent/src/contract.ts"], "changes")).toEqual([
    "agent",
    "computer",
    "daemon",
    "macos-lifecycle",
    "web",
    "windows-release",
  ]);
});

test("documentation skips application checks, while shared and unknown inputs fail open to full coverage", () => {
  expect(
    selectChecks(["README.md", "docs/release.md", "packages/daemon/AGENTS.md"], "changes"),
  ).toEqual([]);
  const all = [
    "agent",
    "cli",
    "computer",
    "daemon",
    "deploy",
    "macos-lifecycle",
    "oss-cdn",
    "protocol",
    "release",
    "web",
    "windows-installer",
    "windows-release",
  ];
  for (const path of [
    "bun.lock",
    "mise.toml",
    "package.json",
    "packages/computer/package.json",
    "apps/web/package.json",
    ".github/workflows/ci.yml",
    "packages/new/src/index.ts",
    "packages/protocol/messages.ts",
  ]) {
    expect(selectChecks([path], "changes")).toEqual(all);
  }
  expect(selectChecks(["packages/computer/src/cli.ts"], "changes")).toEqual([
    "computer",
    "macos-lifecycle",
    "windows-release",
  ]);
  expect(selectChecks(["scripts/release/install.ps1"], "changes")).toEqual([
    "release",
    "web",
    "windows-installer",
  ]);
  expect(selectChecks(["scripts/release/install.sh"], "changes")).toEqual(["release", "web"]);
  expect(selectChecks(["infra/staging/caddy/Caddyfile"], "changes")).toEqual(["deploy", "web"]);
  expect(selectChecks(["scripts/release/compile-targets.ts"], "changes")).toEqual([
    "computer",
    "daemon",
    "macos-lifecycle",
    "release",
    "windows-release",
  ]);
});

test("deployment validates the exact Web track only when the image or deployment is affected", () => {
  for (const path of [
    "docs/release.md",
    "packages/daemon/src/runtime.ts",
    "scripts/release/publish.ts",
  ]) {
    expect(selectChecks([path], "web")).toEqual([]);
  }
  for (const path of [
    "apps/web/src/index.ts",
    "scripts/release/install.ps1",
    "packages/agent/src/contract.ts",
    "bun.lock",
  ]) {
    expect(selectChecks([path], "web")).toEqual(["deploy", "protocol", "web"]);
  }
});

test("manual local publication always validates its complete track, regardless of changed files", () => {
  expect(selectChecks([], "local")).toEqual([
    "agent",
    "cli",
    "computer",
    "daemon",
    "macos-lifecycle",
    "protocol",
    "release",
    "windows-installer",
    "windows-release",
  ]);
});

test("workflow selection accepts NUL-delimited filenames and emits job and matrix outputs", async () => {
  const child = Bun.spawn([process.execPath, "scripts/ci/selection.ts", "changes"], {
    stdin: new Blob(["apps/web/src/a\npage.tsx\0packages/cli/src/cli.ts\0"]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output).toContain('libraries=["cli"]\n');
  expect(output).toContain("contracts=[]\n");
  expect(output).toContain(
    'jobs=["changes","libraries","computer","daemon","macos-lifecycle","web","windows-release"]\n',
  );
});
