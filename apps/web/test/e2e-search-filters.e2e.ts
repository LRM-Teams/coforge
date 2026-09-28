import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * The search page's filters in a real browser. From, Scope, Channel and Time narrow the results
 * and live in the URL, so a reload keeps them (chip labels included) and Back undoes a change.
 * A Scope that contradicts the sender drops the sender, and a sender that contradicts the Scope
 * drops that part of it. Filters search on their own without a query; Sort needs a query and
 * Recent orders newest first. Clear all resets every filter but keeps the sort.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. Seeds are deterministic
 * and reset on every run. Screenshots are written under `.amp/e2e/search-filters/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/search-filters");

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

test("search filters narrow results, survive a reload, and clear together", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `search-filters-${process.pid}`;
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
  async function evaluate<T>(expression: string): Promise<T> {
    return JSON.parse(JSON.parse(await browser("eval", `JSON.stringify(${expression})`))) as T;
  }
  /** Waits for a page condition, failing with the condition itself after 15 s. */
  const waitFor = (condition: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      browser("wait", "--fn", condition).finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void browser(
            "eval",
            `location.search + " | " + document.querySelector("main")?.innerText`,
          )
            .catch((error: unknown) => String(error))
            .then((page) =>
              reject(new Error(`Timed out waiting for: ${condition}\nPage: ${page}`)),
            );
        }, 15_000);
      }),
    ]);
  };
  const find = (selector: string, predicate: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find((element) => ${predicate})`;
  /** A filter chip: a button in the filter bar whose text starts with `prefix`. */
  const chip = (prefix: string) =>
    find(
      '[aria-label="Search filters"] button',
      `element.textContent.trim().startsWith(${JSON.stringify(prefix)})`,
    );
  const option = (text: string) =>
    find(
      '[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"]',
      // A person's row also shows an avatar initial before the name and `@username` after it.
      `element.textContent.includes(${JSON.stringify(text)})`,
    );
  async function pick(chipPrefix: string, optionText: string) {
    await browser("eval", `${chip(chipPrefix)}.click()`);
    await waitFor(`${option(optionText)} !== undefined`);
    await browser("eval", `${option(optionText)}.click()`);
  }
  const param = (name: string) =>
    `new URLSearchParams(location.search).getAll(${JSON.stringify(name)}).join(",")`;
  const resultIds = () =>
    evaluate<string[]>(
      `[...document.querySelectorAll("main ol li [data-search-message-id]")].map((row) => row.dataset.searchMessageId)`,
    );
  /** Waits for a settled list of `count` rows; zero means the no-results state is showing. */
  const waitForResults = (count: number) =>
    waitFor(
      count === 0
        ? `/No results for|No matching messages/.test(document.querySelector("main").textContent)`
        : `!document.querySelector('[aria-busy="true"]') && document.querySelectorAll("main ol li [data-search-message-id]").length === ${count}`,
    );

  const channelA = seededUuid("e2e-search-filters:channel-a");
  const channelB = seededUuid("e2e-search-filters:channel-b");
  const agentId = seededUuid("e2e-search-filters:agent");
  const phrase = "筛选样本";
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
    });
    const workspaceId = membership.workspaceId;
    await db.conversation.deleteMany({ where: { id: { in: [channelA, channelB] } } });
    await db.conversation.deleteMany({
      where: { workspaceId, channelName: { in: ["e2e-filter-a", "e2e-filter-b"] } },
    });
    await db.agent.upsert({
      where: { id: agentId },
      update: { deletedAt: null, visibility: "public" },
      create: {
        id: agentId,
        workspaceId,
        ownerId: DEV_BROWSER_USER.id,
        name: "e2e-search-bot",
        displayName: "Search Bot",
        runtimeConfig: {
          runtime: "claude-code",
          provider: { kind: "default" },
          model: "claude-opus-4-6",
          modelProvider: "",
          reasoning: "high",
        },
      },
    });
    await db.conversation.createMany({
      data: [
        { id: channelA, workspaceId, channelName: "e2e-filter-a", description: "" },
        { id: channelB, workspaceId, channelName: "e2e-filter-b", description: "" },
      ],
    });
    const human = await db.conversationMember.create({
      data: { conversationId: channelA, workspaceId, userId: DEV_BROWSER_USER.id },
    });
    const botInA = await db.conversationMember.create({
      data: { conversationId: channelA, workspaceId, agentId },
    });
    const botInB = await db.conversationMember.create({
      data: { conversationId: channelB, workspaceId, agentId },
    });
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
    const humanToday = await db.message.create({
      data: {
        conversationId: channelA,
        workspaceId,
        senderMemberId: human.id,
        // The newest and the longest body, so Relevant (which favours short, focused matches)
        // ranks it last while Recent ranks it first.
        body: `${phrase} from a human, in a message long enough that its match is a small part of it`,
        sequence: 2,
        createdAt: daysAgo(0),
      },
    });
    const agentOld = await db.message.create({
      data: {
        conversationId: channelA,
        workspaceId,
        senderMemberId: botInA.id,
        body: `<@human:${DEV_BROWSER_USER.id}> ${phrase} ten days ago`,
        sequence: 1,
        createdAt: daysAgo(10),
      },
    });
    await db.messageMention.create({
      data: {
        messageId: agentOld.id,
        memberId: human.id,
        conversationId: channelA,
        workspaceId,
        kind: "user",
        actorId: DEV_BROWSER_USER.id,
        handle: DEV_BROWSER_USER.username,
      },
    });
    const agentInB = await db.message.create({
      data: {
        conversationId: channelB,
        workspaceId,
        senderMemberId: botInB.id,
        body: `${phrase} in the second channel`,
        sequence: 1,
        createdAt: daysAgo(1),
      },
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/search?q=${encodeURIComponent(phrase)}`);
    await waitForResults(3);
    // Sorting applies to a query; the chip starts on Relevant, which ranks the long newest last.
    expect(await evaluate<boolean>(`${chip("Sort")}.disabled`)).toBe(false);
    expect((await resultIds()).at(-1)).toBe(humanToday.id);

    // From: only the chosen sender, named on the chip, and kept by a reload.
    await pick("From", "Search Bot");
    await waitFor(`${param("senderId")} === ${JSON.stringify(agentId)}`);
    await waitForResults(2);
    expect((await resultIds()).sort()).toEqual([agentOld.id, agentInB.id].sort());
    await browser("reload");
    await waitFor(`${chip("From: Search Bot")} !== undefined`);
    await waitForResults(2);
    await browser("screenshot", join(artifacts, "from.png"));

    // Scope Humans contradicts an Agent sender, so the sender goes.
    await pick("Scope", "Humans");
    await browser("press", "Escape");
    await waitFor(`${param("scope")} === "humans" && ${param("senderId")} === ""`);
    await waitForResults(1);
    expect(await resultIds()).toEqual([humanToday.id]);

    // Back undoes a filter change: the Agent sender returns and the scope goes.
    await browser("back");
    await waitFor(
      `${param("scope")} === "" && ${param("senderId")} === ${JSON.stringify(agentId)}`,
    );
    await waitForResults(2);

    // An Agent sender contradicts a Humans-only scope, so that part of the scope goes.
    await browser(
      "open",
      `${origin}/en/search?q=${encodeURIComponent(phrase)}&scope=mentioned,humans`,
    );
    await waitForResults(0);
    await pick("From", "Search Bot");
    await waitFor(
      `${param("scope")} === "mentioned" && ${param("senderId")} === ${JSON.stringify(agentId)}`,
    );
    await waitForResults(1);
    expect(await resultIds()).toEqual([agentOld.id]);

    // A sender the filters cannot name (gone from the Workspace) is dropped by a Humans-only
    // scope too, instead of leaving a search that can match nothing.
    const unknownSender = seededUuid("e2e-search-filters:unknown-sender");
    await browser(
      "open",
      `${origin}/en/search?q=${encodeURIComponent(phrase)}&senderId=${unknownSender}`,
    );
    await waitForResults(0);
    await pick("Scope", "Humans");
    await browser("press", "Escape");
    await waitFor(`${param("scope")} === "humans" && ${param("senderId")} === ""`);
    await waitForResults(1);

    // Recent orders newest first; the sort is kept by Clear all, every filter goes.
    await pick("Sort", "Recent");
    await waitFor(`${param("sort")} === "recent"`);
    await browser("eval", `${chip("Clear all")}.click()`);
    await waitFor(`${param("scope")} === "" && ${param("sort")} === "recent"`);
    await waitForResults(3);
    expect(await resultIds()).toEqual([humanToday.id, agentInB.id, agentOld.id]);

    // @ Me: only the message that mentions the viewer.
    await pick("Scope", "@ Me");
    await browser("press", "Escape");
    await waitFor(`${param("scope")} === "mentioned"`);
    await waitForResults(1);
    expect(await resultIds()).toEqual([agentOld.id]);
    await browser("eval", `${chip("Clear all")}.click()`);

    // Time: the last 7 days leave out the ten-day-old message; Today leaves out yesterday's.
    await pick("Time", "Last 7 days");
    await waitFor(`${param("range")} === "7d"`);
    await waitForResults(2);
    expect((await resultIds()).sort()).toEqual([humanToday.id, agentInB.id].sort());
    await pick("Last 7 days", "Today");
    await waitFor(`${param("range")} === "today"`);
    await waitForResults(1);
    expect(await resultIds()).toEqual([humanToday.id]);

    // A reload keeps every filter and names it on its chip.
    await pick("Scope", "Humans");
    await browser("press", "Escape");
    await waitFor(`${param("scope")} === "humans"`);
    await browser("reload");
    await waitFor(
      `${chip("Scope 1")} !== undefined && ${chip("Today")} !== undefined && ${chip("Sort: Recent")} !== undefined`,
    );
    await waitForResults(1);
    await browser("eval", `${chip("Clear all")}.click()`);

    // Channel, then no query: the filter alone searches, and Sort waits for a query.
    await pick("Channel", "#e2e-filter-b");
    await waitFor(`${param("channelId")} === ${JSON.stringify(channelB)}`);
    await waitForResults(1);
    await browser(
      "eval",
      `(() => {
        const input = document.querySelector('input[type="search"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "");
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      })()`,
    );
    await waitFor(`${param("q")} === ""`);
    await waitFor(`${chip("Sort")}.disabled === true`);
    await waitForResults(1);
    expect(await resultIds()).toEqual([agentInB.id]);
    await browser("screenshot", join(artifacts, "filter-only.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channelA, channelB] } } })
      .catch(() => {});
    await db.agent
      .update({ where: { id: agentId }, data: { deletedAt: new Date() } })
      .catch(() => {});
    await db.$disconnect();
  }
}, 240_000);
