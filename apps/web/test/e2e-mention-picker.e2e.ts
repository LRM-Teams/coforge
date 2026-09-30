import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";

/**
 * Mentioning people by the name they are shown by, in a real browser: the composer's `@` list finds a
 * person by their name (in CJK too) and shows no handle for them, choosing one writes the name
 * (`@张三`) into the plain textarea, and sending stores a real mention of that person, found by
 * reading the message and its mention rows back from the database. Five paths:
 *
 * - picking `@张三` from the list, then typing on, stores `<@human:id> 你好` and one mention row;
 * - the same pick survives a reload of the page (the draft keeps who was meant beside its text);
 * - a name typed by hand (`@李四`) is offered back as "Did you mean 李四"; choosing binds it, so the
 *   sent message mentions 李四, while text left unpicked stays text;
 * - two people who read identically (`王五`, same description) show their handles in the list, and
 *   the second is mentioned, by id, though both names are the same text;
 * - one of them picked, their name deleted, then the other picked: the other is the one mentioned.
 *
 * Opt-in like the other browser E2Es: real local Web (the dev server with `COFORGE_DEV_SKIP_AUTH=1`
 * and a seeded database, `bun run seed:dev`), `agent-browser`, and local PostgreSQL. Everything it
 * writes lives in a Workspace of its own that it deletes afterwards. It needs no Centrifugo: a send
 * merges the server's answer into the page directly. Screenshots and `summary.json` (each sent
 * message as stored) are written under `.amp/e2e/mention-picker/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/mention-picker");

test("people are mentioned by the name they are shown by: picked, kept across a reload, hand-typed then confirmed, and told apart by id", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `mention-picker-${process.pid}`;
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
  /** Waits for `condition` in the page, failing with its text rather than at the test timeout. */
  const waitFor = (condition: string, ms = 20_000) =>
    Promise.race([
      browser("wait", "--fn", condition),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for ${condition}`)), ms),
      ),
    ]);
  /** Polls `read` until it answers, so a check waits for the row a send commits, not for a delay. */
  async function until<T>(what: string, read: () => Promise<T | null | undefined>, ms = 20_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = await read();
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const composer = `document.querySelector('form textarea')`;
  const composerText = `${composer}.value`;
  const listbox = `document.querySelector('[role="listbox"]')`;
  const listText = `(${listbox}?.textContent ?? "")`;

  const suffix = String(process.pid);
  const slug = `e2e-mention-${suffix}`;
  const person = (username: string, displayName: string, description: string) =>
    db.user.create({
      data: { username: `e2e-${username}-${suffix}`, displayName, description },
    });
  const [zhang, wangA, wangB, li] = await Promise.all([
    person("zhang", "张三", "Design"),
    person("wang-a", "王五", "Sales"),
    person("wang-b", "王五", "Sales"),
    person("li", "李四", "Ops"),
  ]);
  const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
    slug,
    name: "E2E mention picker",
    userId: DEV_BROWSER_USER.id,
  });
  const summary: Record<string, unknown> = {};
  try {
    const channels = new PublicChannels(db, undefined, {
      publish: async () => {},
      publishJson: async () => {},
      broadcast: async () => {},
    });
    const channel = await channels.create(workspace.id, DEV_BROWSER_USER.id, `mention-${suffix}`);
    for (const member of [zhang, wangA, wangB, li]) {
      await db.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: member.id },
      });
      await db.conversationMember.create({
        data: { workspaceId: workspace.id, conversationId: channel.id, userId: member.id },
      });
    }
    await mkdir(artifacts, { recursive: true });

    /** The next message the viewer sent to the channel, as stored, with the people it mentions. */
    let sentBefore = 0;
    async function nextSent() {
      const message = await until("the sent message", async () => {
        const sent = await db.message.findMany({
          where: { conversationId: channel.id, sender: { userId: DEV_BROWSER_USER.id } },
          orderBy: { sequence: "asc" },
          include: { mentions: true },
        });
        return sent.length > sentBefore ? sent[sentBefore] : undefined;
      });
      sentBefore += 1;
      return message;
    }

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${slug}/channel/${channel.id}`);
    await waitFor(`${composer} !== null && !${composer}.disabled`, 60_000);

    // 1. A CJK query opens the list; it shows the person's name and description, never a handle.
    await browser("focus", "form textarea");
    await browser("keyboard", "type", "@");
    await browser("keyboard", "inserttext", "张");
    await waitFor(`${listText}.includes("张三")`);
    const row = await browser("eval", `${listText}`);
    expect(row).toContain("Design");
    expect(row).not.toContain(zhang.username);
    expect(row).not.toContain("李四");
    await browser("screenshot", join(artifacts, "1-list-by-name.png"));
    // Choosing writes the name, not the handle, into the plain textarea.
    await browser("press", "Enter");
    await waitFor(`${composerText} === "@张三 "`);
    await browser("keyboard", "inserttext", "你好");
    await browser("screenshot", join(artifacts, "2-name-in-composer.png"));

    // 2. The pick is kept with the draft across a reload, and sending still mentions the person.
    await browser("reload");
    await waitFor(`${composer} !== null && !${composer}.disabled`, 60_000);
    await waitFor(`${composerText} === "@张三 你好"`);
    await browser("focus", "form textarea");
    await browser("press", "Enter");
    const first = await nextSent();
    expect(first.body).toBe(`<@human:${zhang.id}> 你好`);
    expect(first.mentions.map((mention) => [mention.kind, mention.actorId])).toEqual([
      ["user", zhang.id],
    ]);
    await waitFor(`document.body.textContent.includes("你好")`);
    // The stream reads the name, and the person's handle appears nowhere on the page.
    expect(
      await browser(
        "eval",
        `document.body.textContent.includes(${JSON.stringify(zhang.username)})`,
      ),
    ).toContain("false");
    await browser("screenshot", join(artifacts, "3-sent.png"));
    summary.picked = { body: first.body, mentions: first.mentions.map((m) => m.actorId) };

    // 3. A name typed by hand is offered back, and confirming it makes a real mention.
    await browser("focus", "form textarea");
    await browser("keyboard", "inserttext", "@李四 请看一下");
    await waitFor(`document.body.textContent.includes("Did you mean")`);
    await browser("screenshot", join(artifacts, "4-did-you-mean.png"));
    await browser("click", '[aria-label="Mention 李四"]');
    await waitFor(`!document.body.textContent.includes("Did you mean")`);
    await browser("press", "Enter");
    const second = await nextSent();
    expect(second.body).toBe(`<@human:${li.id}> 请看一下`);
    expect(second.mentions.map((mention) => mention.actorId)).toEqual([li.id]);
    summary.hintConfirmed = { body: second.body, mentions: second.mentions.map((m) => m.actorId) };

    // 3b. A hand-typed name left unconfirmed stays plain text and notifies no one.
    await browser("focus", "form textarea");
    await browser("keyboard", "inserttext", "@李四 只是文字");
    await waitFor(`document.body.textContent.includes("Did you mean")`);
    await browser("press", "Enter");
    const third = await nextSent();
    expect(third.body).toBe("@李四 只是文字");
    expect(third.mentions).toEqual([]);
    summary.hintIgnored = { body: third.body, mentions: [] };

    // 4. Two people who read identically show their handles, and the second row is the second person.
    await browser("focus", "form textarea");
    await browser("keyboard", "type", "@");
    await browser("keyboard", "inserttext", "王");
    await waitFor(`${listText}.includes(${JSON.stringify(wangB.username)})`);
    const both = await browser("eval", `${listText}`);
    expect(both).toContain(`@${wangA.username}`);
    expect(both).toContain(`@${wangB.username}`);
    await browser("screenshot", join(artifacts, "5-look-alikes.png"));
    // The second of the two, chosen with the pointer (the first pick above used the keyboard).
    await browser("click", '[role="listbox"] [role="option"]:nth-child(2)');
    await waitFor(`${composerText} === "@王五 "`);
    await browser("keyboard", "inserttext", "在吗");
    await browser("press", "Enter");
    const fourth = await nextSent();
    expect(fourth.body).toBe(`<@human:${wangB.id}> 在吗`);
    expect(fourth.mentions.map((mention) => mention.actorId)).toEqual([wangB.id]);
    summary.lookAlike = { body: fourth.body, mentions: fourth.mentions.map((m) => m.actorId) };

    // 5. One look-alike picked, their name deleted, then the other picked: the second is mentioned.
    await browser("focus", "form textarea");
    await browser("keyboard", "inserttext", "hi ");
    await browser("keyboard", "type", "@");
    await browser("keyboard", "inserttext", "王");
    await waitFor(`${listText}.includes(${JSON.stringify(wangA.username)})`);
    await browser("click", '[role="listbox"] [role="option"]:nth-child(1)');
    await waitFor(`${composerText} === "hi @王五 "`);
    for (let index = 0; index < "@王五 ".length; index += 1) await browser("press", "Backspace");
    await waitFor(`${composerText} === "hi "`);
    await browser("keyboard", "type", "@");
    await browser("keyboard", "inserttext", "王");
    await waitFor(`${listText}.includes(${JSON.stringify(wangB.username)})`);
    await browser("click", '[role="listbox"] [role="option"]:nth-child(2)');
    await waitFor(`${composerText} === "hi @王五 "`);
    await browser("keyboard", "inserttext", "在");
    await browser("press", "Enter");
    const fifth = await nextSent();
    expect(fifth.body).toBe(`hi <@human:${wangB.id}> 在`);
    expect(fifth.mentions.map((mention) => mention.actorId)).toEqual([wangB.id]);
    summary.repicked = { body: fifth.body, mentions: fifth.mentions.map((m) => m.actorId) };

    await writeFile(join(artifacts, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  } catch (failure) {
    // What the page looked like when it went wrong.
    await browser("screenshot", join(artifacts, "failure.png")).catch(() => undefined);
    throw failure;
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.user
      .deleteMany({ where: { id: { in: [zhang.id, wangA.id, wangB.id, li.id] } } })
      .catch(() => {});
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
