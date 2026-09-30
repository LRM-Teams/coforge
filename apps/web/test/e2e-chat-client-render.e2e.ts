import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { peopleDirectKey } from "#src/features/conversations/direct-key";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * A chat page's server HTML is a loading screen, as Slack's is: the app's chrome and a skeleton, and
 * nothing of the Workspace's conversations. The sidebar's channel and DM lists, a conversation's
 * messages and the Saved list all come from the browser's own requests, so none of their text is in
 * the document the server sends; a real browser then shows them. Checked on a channel and on a
 * direct message, where the messages were server-rendered before, and on the search page opened on a
 * conversation, whose loader read the conversation for the browser.
 *
 * Opt-in like the other browser E2Es: real local Web (a dev server, or a production build run with
 * `NODE_ENV=development` and `COFORGE_DEV_SKIP_AUTH` set to `1`/`true`/`yes`, so the dev sign-in bypass is on) + `agent-browser`, and the dev user
 * an owner of its Workspace (seed-dev). Each run seeds two channels and a direct message with
 * uniquely named content, saves one message, and removes them afterwards. The server HTML of each
 * page, a screenshot of each page in the browser, and the sizes measured are written under
 * `.amp/e2e/chat-client-render/`.
 *
 *   COFORGE_E2E_WEB_URL=http://127.0.0.1:8788 REDIS_URL=redis://127.0.0.1:6380 \
 *     bun test ./test/e2e-chat-client-render.e2e.ts
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/chat-client-render");

test("a chat page's server HTML holds no conversation, and the browser shows them", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `chat-client-render-${process.pid}`;
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
  const waitFor = (condition: string, ms = 60_000) =>
    Promise.race([
      browser("wait", "--fn", condition),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for ${condition}`)), ms),
      ),
    ]);
  /** What the page has reported since it was opened: console errors (React logs a hydration
   * mismatch as one) and uncaught errors. */
  async function pageProblems() {
    const consoleLog: { type: string; text: string }[] = JSON.parse(
      await browser("console", "--json"),
    ).data.messages;
    const uncaught: { text: string }[] = JSON.parse(await browser("errors", "--json")).data.errors;
    return [
      ...consoleLog
        .filter((message) => message.type === "error")
        .map((message) => `console.error: ${message.text}`),
      ...uncaught.map((error) => `uncaught: ${error.text}`),
    ];
  }
  const pageText = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;
  async function serverHtml(path: string) {
    const response = await fetch(`${origin}${path}`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    return response.text();
  }
  /** Fails naming the piece of the Workspace's content found in the server's HTML, other than
   * what the page's own address says. */
  function expectNoneOf(html: string, content: Record<string, string>, address: string) {
    const found = Object.entries(content)
      .filter(([, text]) => !address.includes(text) && html.includes(text))
      .map(([what]) => what);
    expect(found).toEqual([]);
  }

  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: { select: { slug: true } } },
  });
  const workspaceId = membership.workspaceId;
  const workspacePath = `/en/w/${membership.workspace.slug}`;
  const run = `e2e-render-${process.pid}`;
  const conversations: string[] = [];
  let failure: { error: unknown } | undefined;
  /** A conversation the dev user is in, holding messages whose text no page or default has. */
  async function seed(data: { channelName?: string; directKey?: string }, label: string) {
    const conversation = await db.conversation.create({
      data: { workspaceId, description: "", ...data },
    });
    conversations.push(conversation.id);
    const member = await db.conversationMember.create({
      data: { conversationId: conversation.id, workspaceId, userId: DEV_BROWSER_USER.id },
    });
    const messages = await Promise.all(
      [1, 2].map((sequence) =>
        db.message.create({
          data: {
            conversationId: conversation.id,
            workspaceId,
            senderMemberId: member.id,
            sequence,
            body: `${label} unique message ${sequence} of ${run}`,
          },
        }),
      ),
    );
    return { conversation, member, messages };
  }
  try {
    const open = await seed({ channelName: `${run}-open` }, "channel");
    const other = await seed({ channelName: `${run}-other` }, "other channel");
    const direct = await seed(
      { directKey: peopleDirectKey(DEV_BROWSER_USER.id, DEV_BROWSER_USER.id) },
      "direct",
    );
    // The Saved list is read for every chat page, and holds message text.
    const saved = open.messages[1]!;
    await db.savedMessage.create({
      data: {
        messageId: saved.id,
        conversationId: open.conversation.id,
        workspaceId,
        memberId: open.member.id,
      },
    });
    await mkdir(artifacts, { recursive: true });

    // Chat's pages, and the search page, whose preview shows a conversation the URL names.
    const pages = {
      channel: {
        path: `${workspacePath}/channel/${open.conversation.id}`,
        seeded: open,
        chat: true,
      },
      dm: { path: `${workspacePath}/dm/${direct.conversation.id}`, seeded: direct, chat: true },
      search: {
        path: `${workspacePath}/search?open=channel:${open.conversation.id}&msg=${open.messages[0]!.id}`,
        seeded: open,
        chat: false,
      },
    };
    const sizes: Record<string, { bytes: number }> = {};
    for (const [name, page] of Object.entries(pages)) {
      const html = await serverHtml(page.path);
      await writeFile(join(artifacts, `${name}.html`), html);
      sizes[name] = { bytes: Buffer.byteLength(html) };
      // The app's chrome is there (the rail's account card), and on Chat's pages the skeleton
      // where the sidebar and the conversation will be.
      expect(html).toContain(DEV_BROWSER_USER.name);
      if (page.chat) expect(html).toContain('aria-busy="true"');
      // Nothing of the Workspace's conversations is, but what the URL names: no message (its text
      // or its id, which also covers the Query state the document carries for the browser), no
      // sidebar row (a channel by name, and a channel other than the one open by id), and no saved
      // message.
      expectNoneOf(
        html,
        {
          ...Object.fromEntries(
            [...open.messages, ...other.messages, ...direct.messages].flatMap((message) => [
              [`message text ${message.body}`, message.body],
              [`message id ${message.id}`, message.id],
            ]),
          ),
          "open channel name": open.conversation.channelName!,
          "other channel name": other.conversation.channelName!,
          "other channel id": other.conversation.id,
          "saved message": saved.body,
        },
        page.path,
      );
    }
    await writeFile(join(artifacts, "sizes.json"), JSON.stringify(sizes, null, 2));

    // The browser, on the other hand, shows the conversation (and on Chat's pages the sidebar)
    // once it has loaded them.
    await browser("set", "viewport", "1440", "900");
    for (const [name, page] of Object.entries(pages)) {
      await browser("open", `${origin}${page.path}`);
      await waitFor(pageText(page.seeded.messages[0]!.body));
      await waitFor(pageText(page.seeded.messages[1]!.body));
      if (page.chat) {
        await waitFor(pageText(open.conversation.channelName!));
        await waitFor(pageText(other.conversation.channelName!));
      }
      await browser("screenshot", join(artifacts, `${name}.png`));
      // Loading the page, hydrating its loading screen and then rendering the conversation
      // reported nothing.
      expect({ page: name, problems: await pageProblems() }).toEqual({ page: name, problems: [] });
    }
  } catch (error) {
    failure = { error };
  }
  // The cleanup runs whether the test passed or failed. Each step runs whatever the others did, and
  // a failed one is reported, not dropped. Messages first: a message keeps its sender's member row
  // from going.
  const cleanupFailures: unknown[] = [];
  for (const step of [
    () => db.message.deleteMany({ where: { conversationId: { in: conversations } } }),
    () => db.conversation.deleteMany({ where: { id: { in: conversations } } }),
    () => browser("close"),
    () => db.$disconnect(),
  ])
    await step().catch((error: unknown) => cleanupFailures.push(error));
  // A failure of the test itself stays the one that is thrown.
  if (failure) {
    if (cleanupFailures.length) console.error("the test's cleanup also failed", cleanupFailures);
    throw failure.error;
  }
  if (cleanupFailures.length)
    throw new AggregateError(cleanupFailures, "the test's cleanup failed");
}, 300_000);
