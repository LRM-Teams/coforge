import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { RedisClient } from "bun";
import { PrismaClient } from "#src/generated/prisma/client";
import { RedisComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * Stopping and resuming every Agent in a channel in a real browser. A member opens the channel
 * settings panel, picks "Stop Agents" under Actions, and confirms; the dialog then says every
 * Agent was stopped, and each of the channel's Agents is stopped for good. The member then gives
 * new guidance and picks "Resume all": the dialog closes and every Agent is started again.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user an owner of
 * its Workspace with a Computer attached (seed-dev), whose status is marked online in Redis for the
 * resume (a stopped Agent on an offline Computer stays stopped). Each run seeds a fresh channel with two
 * fresh Agents and removes them afterwards. Screenshots are written under
 * `.amp/e2e/stop-channel-agents/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
const redisUrl = Bun.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL must name the local Redis the Web service uses");
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/stop-channel-agents");

test("a member stops every Agent in a channel, then resumes them with new guidance", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `stop-channel-agents-${process.pid}`;
  async function browser(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Browser ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  /** Waits for `condition`, failing with its text rather than at the test timeout; a first page
   * load compiles on the dev server, so it gets longer. */
  const waitFor = (condition: string, ms = 20_000) =>
    Promise.race([
      browser("wait", "--fn", condition),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for ${condition}`)), ms),
      ),
    ]);
  const byText = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((element) => element.textContent.trim() === ${JSON.stringify(text)}).at(-1)`;
  async function clickText(selector: string, text: string) {
    await waitFor(`${byText(selector, text)} !== undefined`);
    const clicked = await browser(
      "eval",
      `(() => { const target = ${byText(selector, text)}; target?.click(); return Boolean(target); })()`,
    );
    if (!clicked.includes("true")) throw new Error(`"${text}" disappeared before it was clicked`);
  }

  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
  });
  const workspaceId = membership.workspaceId;
  const attached = await db.workspaceComputer.findFirstOrThrow({
    where: { workspaceId, computer: { ownerId: DEV_BROWSER_USER.id } },
  });
  const channel = await db.conversation.create({
    data: { workspaceId, channelName: `e2e-sos-${process.pid}`, description: "" },
  });
  const agents = await Promise.all(
    ["alpha", "beta"].map((name) =>
      db.agent.create({
        data: {
          workspaceId,
          name: `e2e-sos-${name}-${process.pid}`,
          displayName: `SOS ${name}`,
          ownerId: DEV_BROWSER_USER.id,
          computerId: attached.computerId,
          runtimeConfig: {
            runtime: "pi",
            provider: { kind: "default" },
            model: "",
            modelProvider: "",
            reasoning: "",
          },
        },
      }),
    ),
  );
  const agentIds = agents.map(({ id }) => id);
  try {
    await db.conversationMember.createMany({
      data: [
        { conversationId: channel.id, workspaceId, userId: DEV_BROWSER_USER.id },
        ...agentIds.map((agentId) => ({ conversationId: channel.id, workspaceId, agentId })),
      ],
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/messages/channels/${channel.id}`);
    await waitFor(
      `document.querySelector('[aria-label="Channel details and settings"]') !== null`,
      60_000,
    );
    // A click that lands before the page hydrates opens nothing; try again until the panel opens.
    const panelOpen = `document.querySelector('[role="dialog"][aria-label="Channel details and settings"]') !== null`;
    for (let attempt = 0; ; attempt += 1) {
      await browser("click", '[aria-label="Channel details and settings"]');
      const opened = await waitFor(panelOpen, 5_000).then(
        () => true,
        () => false,
      );
      if (opened) break;
      if (attempt === 5) throw new Error("the channel settings panel never opened");
    }
    await clickText("button", "Stop Agents");
    await waitFor(`document.body.textContent.includes("will stop immediately")`);
    await browser("screenshot", join(artifacts, "confirm.png"));
    await clickText('[role="dialog"] button', "Stop");

    await waitFor(`document.body.textContent.includes("All Agents have been stopped.")`);
    await browser("screenshot", join(artifacts, "stopped.png"));
    const stopped = await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { stoppedAt: true },
    });
    expect(stopped.every(({ stoppedAt }) => stoppedAt !== null)).toBe(true);

    await new RedisComputerStatusCache(new RedisClient(redisUrl)).put(
      { workspaceId, computerId: attached.computerId },
      true,
    );
    // "Resume all" waits for guidance.
    const resumeDisabled = `${byText('[role="dialog"] button', "Resume all")}?.disabled`;
    expect(await browser("eval", resumeDisabled)).toContain("true");
    const guidanceBox = 'textarea[aria-label^="Provide new guidance"]';
    await browser("click", guidanceBox);
    await browser("type", guidanceBox, "Only touch the frontend from now on.");
    await waitFor(`!(${resumeDisabled})`);
    await browser("screenshot", join(artifacts, "guidance.png"));
    await clickText('[role="dialog"] button', "Resume all");
    await waitFor(`!document.body.textContent.includes("All Agents have been stopped.")`);
    const resumed = await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { stoppedAt: true },
    });
    expect(resumed.every(({ stoppedAt }) => stoppedAt === null)).toBe(true);
  } finally {
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => {});
    await db.agent.deleteMany({ where: { id: { in: agentIds } } }).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
