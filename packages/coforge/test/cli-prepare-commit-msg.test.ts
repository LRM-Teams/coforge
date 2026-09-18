import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

async function initRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "coforge-cli-prepare-commit-msg-"));
  await git(repo, ["init", "--quiet"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
  const messageFile = join(repo, ".git", "COMMIT_EDITMSG");
  await writeFile(messageFile, "Add widget\n");
  return repo;
}

const servers: Array<{ stop(): void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

/** `coforge git prepare-commit-msg` must never fail the Agent's commit: a real (unmocked) proxy
 * failure - here, the server answering 500 - still exits 0, with exactly one plain-language
 * stderr line explaining the trailer was skipped. */
test("a real proxy failure exits 0 with exactly one explanatory stderr line", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("upstream failed", { status: 500 }),
  });
  servers.push(server);
  const repo = await initRepo();
  const messageFile = join(repo, ".git", "COMMIT_EDITMSG");

  const process = Bun.spawn(["bun", "run", CLI_PATH, "git", "prepare-commit-msg", messageFile], {
    cwd: repo,
    env: {
      ...Bun.env,
      COFORGE_AGENT_CONTEXT: `sfp_${"a".repeat(43)}`,
      COFORGE_AGENT_PROXY_URL: `http://127.0.0.1:${server.port}/api/agent/v1/messages`,
      COFORGE_DAEMON_SOCKET: "",
    },
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(15_000),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  expect(exitCode).toBe(0);
  expect(stdout).toBe("");
  const stderrLines = stderr.trim().split("\n");
  expect(stderrLines).toHaveLength(1);
  expect(stderrLines[0]).toStartWith("coforge: CoForge co-author trailer skipped:");
  // Never fails the commit, and never invents a trailer of its own.
  expect(await readFile(messageFile, "utf8")).toBe("Add widget\n");
});

test("an unreachable proxy (closed port) also exits 0 with one stderr line", async () => {
  const repo = await initRepo();
  const messageFile = join(repo, ".git", "COMMIT_EDITMSG");

  // Bind a server, read its free port, then stop it immediately so the port stays closed.
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const closedPort = probe.port;
  probe.stop(true);

  const process = Bun.spawn(["bun", "run", CLI_PATH, "git", "prepare-commit-msg", messageFile], {
    cwd: repo,
    env: {
      ...Bun.env,
      COFORGE_AGENT_CONTEXT: `sfp_${"a".repeat(43)}`,
      COFORGE_AGENT_PROXY_URL: `http://127.0.0.1:${closedPort}/api/agent/v1/messages`,
      COFORGE_DAEMON_SOCKET: "",
    },
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(15_000),
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(process.stderr).text(),
    process.exited,
  ]);

  expect(exitCode).toBe(0);
  const stderrLines = stderr.trim().split("\n");
  expect(stderrLines).toHaveLength(1);
  expect(stderrLines[0]).toStartWith("coforge: CoForge co-author trailer skipped:");
});
