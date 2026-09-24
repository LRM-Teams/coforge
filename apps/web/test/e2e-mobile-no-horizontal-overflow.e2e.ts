import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { DEV_BROWSER_USER } from "../src/server/auth/dev-skip-auth.server";

/**
 * The regression that proved the boss's E2E-first policy (#790): a `<TooltipTrigger>` wrapper
 * slipped between the system-notice row's flex line and its `min-w-0 flex-1` span, the span
 * stopped being the flex item, a long notice grew the row past the container, and on a phone
 * the whole message stream scrolled sideways. tsc and the unit suites were all green — only a
 * narrow-viewport browser could see it.
 *
 * So this test pins that regression and is the first exemplar of the policy: at a phone
 * viewport, a channel holding pathologically long system notices must have NO horizontal
 * overflow anywhere — the page and the stream keep `scrollWidth <= clientWidth`, and each
 * notice stays a single clipped line.
 *
 * Opt-in like the other browser E2Es: real local Web (managed-web.sh) + `agent-browser`; the
 * long notices are seeded deterministically, so reruns restore the same rows instead of
 * duplicating them.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

// The ASCII token far wider than a 390px viewport is the point: when the row's truncation
// chain holds, `truncate` clips it; when the flex chain breaks (min-width:auto back on a
// wrapped item), this token is what pushes the row — and the whole stream — sideways.
const NOTICES = [
  "任务 #9001 “为保存的视图建立移动端列宽的自适应规则与回退策略” - in progress · glm-5-3-flash",
  "system-notice-with-a-very-long-unbreakable-ascii-token-0123456789abcdef0123456789abcdef-end",
  "成员 @jordan 加入了频道，并由 @dev-user 授予了查看已保存消息与任务看板的权限，此通知特意写得足够长以覆盖多行场景。",
];

test("a phone viewport never scrolls the message stream sideways, even with long system notices", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `mobile-overflow-${process.pid}`;
  async function browser(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      env: { ...Bun.env, AGENT_BROWSER_DEFAULT_TIMEOUT: "15000" },
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
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
    });
    const channel = await db.conversation.findFirstOrThrow({
      where: { workspaceId: membership.workspaceId, channelName: { not: null }, archivedAt: null },
      orderBy: { createdAt: "asc" },
    });
    // Seed the long system notices (a sender-less Message row renders as a system row) at the
    // channel's tail, deterministically addressed so a rerun restores instead of duplicating.
    const last = await db.message.aggregate({
      where: { conversationId: channel.id },
      _max: { sequence: true },
    });
    let sequence = (last._max.sequence ?? 0) + 1;
    for (const body of NOTICES) {
      const id = seededUuid(`e2e-mobile-overflow:${body.slice(0, 40)}`);
      await db.message.upsert({
        where: { id },
        update: { body, sequence },
        create: {
          id,
          conversationId: channel.id,
          workspaceId: channel.workspaceId,
          body,
          sequence,
        },
      });
      sequence += 1;
    }

    await browser("open", `${origin}/en/messages/channels/${channel.channelName}`);
    await browser("set", "viewport", "390", "844", "3");
    await browser("wait", "--url", `**/messages/channels/${channel.channelName}`);
    await browser("wait", "--fn", `document.querySelector('[data-message="system"]') !== null`);
    // Every notice is one clipped line: an unclipped one (the regression) wraps or grows tall.
    await browser(
      "wait",
      "--fn",
      `Array.from(document.querySelectorAll('[data-message="system"]')).every(
        (row) => !row.textContent.includes("0123456789abcdef") || row.clientHeight <= 64,
      )`,
    );
    const overflow = JSON.parse(
      await browser(
        "eval",
        `JSON.stringify((() => {
          const page = document.documentElement.scrollWidth - document.documentElement.clientWidth;
          const stream = [...document.querySelectorAll("div")].find((e) =>
            e.className.includes("overflow-y-auto"),
          );
          return {
            page,
            stream: stream ? stream.scrollWidth - stream.clientWidth : -1,
            systemRows: document.querySelectorAll('[data-message="system"]').length,
          };
        })())`,
      ),
    );
    expect(overflow.systemRows).toBeGreaterThanOrEqual(NOTICES.length);
    expect(overflow.page).toBeLessThanOrEqual(1);
    expect(overflow.stream).toBeLessThanOrEqual(1);
  } finally {
    await db.$disconnect();
  }
});
