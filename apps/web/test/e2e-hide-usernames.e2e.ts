import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { peopleDirectKey } from "#src/features/conversations/direct-key";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";

/**
 * A person is shown by their name, never by their `@username`. Settings → Account edits a required
 * full name and an optional display name (a display name equal to the full name is stored as
 * none, and the username is not shown or editable); Settings → Members, its Invite dialog (the
 * join link alone, no invite by username), the Members directory and a channel's members page
 * (roster and add view) list people by their names and do not show, or search by, their
 * usernames; a person is still found by the full name a nickname replaced. The Search page's
 * From filter and its Frequently used direct message name people the same way, while an Agent
 * keeps its `@handle`.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`) + `agent-browser`
 * against the dev database. It seeds one Workspace whose owner is the dev user, with two more
 * members whose usernames are unmistakable, and removes what it created (the dev user's names are
 * put back). Screenshots and `summary.json` are written under `.amp/e2e/hide-usernames/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/hide-usernames");

test("people are shown by their names, and no screen shows a username", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `hide-usernames-${process.pid}`;
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
  /** Waits for a page condition, failing with the condition and the page text after 15 s. */
  const waitFor = (condition: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      browser("wait", "--fn", condition).finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void browser(
            "eval",
            `location.pathname + location.search + " | " + document.querySelector("main")?.innerText.slice(0, 600)`,
          )
            .catch((error: unknown) => String(error))
            .then((page) =>
              reject(new Error(`Timed out waiting for: ${condition}\nPage: ${page}`)),
            );
        }, 15_000);
      }),
    ]);
  };
  const mainText = () => evaluate<string>(`document.querySelector("main")?.innerText ?? ""`);
  /** A button of the page's main region, by its exact label. */
  const mainButton = (label: string) =>
    `[...document.querySelectorAll("main button")].find((button) => button.textContent.trim() === ${JSON.stringify(label)})`;
  /** Whether React has hydrated `element`: before that a server-rendered button does nothing. */
  const hydrated = (element: string) =>
    `Object.keys(${element} ?? {}).some((key) => key.startsWith("__reactProps"))`;
  const saved = `document.querySelector("main [role=status]")?.textContent.includes("Profile saved")`;
  /** The edit form is up when its two name fields (a text input each) are: the avatar input is a file. */
  const nameFields = `document.querySelectorAll('main input:not([type="file"])').length === 2`;

  const checks: { name: string; passed: boolean }[] = [];
  const screenshots: string[] = [];
  /** Records a check before asserting it, so `summary.json` shows what ran even on a failure. */
  const check = (name: string, passed: boolean) => {
    checks.push({ name, passed });
    expect(passed, name).toBe(true);
  };
  const shoot = async (name: string) => {
    await browser("screenshot", join(artifacts, `${name}.png`));
    screenshots.push(`${name}.png`);
  };

  const uid = crypto.randomUUID().slice(0, 4);
  const slug = "e2e-hide-usernames";
  const usernames = {
    ada: `e2e-hide-ada-zq7k${uid}`,
    grace: `e2e-hide-grace-zq7k${uid}`,
    lin: `e2e-hide-lin-zq7k${uid}`,
  };
  const memberIds: string[] = [];
  const viewerBefore = await db.user.findUnique({ where: { id: DEV_BROWSER_USER.id } });
  let workspaceId: string | undefined;
  try {
    // A leftover from an interrupted run starts over.
    await db.workspace.deleteMany({ where: { slug } });
    await db.user.deleteMany({ where: { username: { startsWith: "e2e-hide-" } } });
    await db.user.upsert({
      where: { id: DEV_BROWSER_USER.id },
      create: {
        id: DEV_BROWSER_USER.id,
        username: DEV_BROWSER_USER.username,
        fullName: "Dev Viewer",
      },
      update: { fullName: "Dev Viewer", displayName: null },
    });
    const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
      slug,
      name: "Hidden Handles",
      userId: DEV_BROWSER_USER.id,
    });
    workspaceId = workspace.id;
    const people = [];
    for (const data of [
      { username: usernames.ada, fullName: "Ada Lovelace" },
      { username: usernames.grace, fullName: "Grace Hopper", displayName: "Amazing Grace" },
      { username: usernames.lin, fullName: "Lin Chen", displayName: "Lindy" },
    ]) {
      const user = await db.user.create({ data });
      memberIds.push(user.id);
      people.push(user);
      await db.workspaceMembership.create({
        data: { workspaceId, userId: user.id, role: "member" },
      });
    }
    // A channel with the viewer (its admin), Ada and Grace; Lin is a Workspace member outside it.
    const channel = await db.conversation.create({
      data: { workspaceId, channelName: "hide-team", description: "" },
    });
    await db.conversationMember.createMany({
      data: [
        {
          conversationId: channel.id,
          workspaceId,
          userId: DEV_BROWSER_USER.id,
          channelRole: "admin",
        },
        { conversationId: channel.id, workspaceId, userId: people[0]!.id },
        { conversationId: channel.id, workspaceId, userId: people[1]!.id },
      ],
    });
    const handles = [DEV_BROWSER_USER.username, ...Object.values(usernames)];
    /** No handle appears in `text`, plain or as an `@mention`. */
    const showsNoUsername = (text: string) => handles.every((handle) => !text.includes(handle));
    const base = `${origin}/en/w/${slug}`;
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    // Settings → Account: the read view names both names and no username.
    await browser("open", `${base}/settings?section=account`);
    await waitFor(hydrated(mainButton("Edit")));
    let text = await mainText();
    check(
      "account: read view lists Full name and Display name",
      /Full name/.test(text) && /Display name/.test(text),
    );
    check("account: read view has no Username row", !/Username/i.test(text));
    check("account: read view shows no @username", showsNoUsername(text));
    check("account: with no display name the full name is the name", /Dev Viewer/.test(text));
    await shoot("settings-profile");

    // The edit form: a required Full name and an optional Display name, and no username.
    await browser("eval", `${mainButton("Edit")}.click()`);
    await waitFor(nameFields);
    text = await mainText();
    check(
      "account: edit form has Full name and Display name fields",
      /Full name/.test(text) && /Display name/.test(text),
    );
    check("account: edit form says the display name is optional", /Optional/.test(text));
    check(
      "account: edit form has no Username field or 'cannot be changed' copy",
      !/Username|cannot be changed/i.test(text),
    );
    check("account: edit form shows no @username", showsNoUsername(text));
    await shoot("settings-profile-edit");

    // A name the rule refuses says why where it is typed, and cannot be saved.
    const saveDisabled = `${mainButton("Save")}?.disabled === true`;
    for (const [typed, reason] of [
      ["System", "You can't use this name."],
      ["a".repeat(81), "Use 80 characters or fewer."],
      // Blank: an empty fill is ignored by the browser tool, and a space normalizes to nothing.
      [" ", "Enter your full name."],
    ] as const) {
      await browser("find", "label", "Full name", "fill", typed);
      await waitFor(
        `document.querySelector("main")?.innerText.includes(${JSON.stringify(reason)})`,
      );
      check(
        `account: a full name refused as "${reason}" cannot be saved`,
        await evaluate<boolean>(saveDisabled),
      );
    }
    await browser("find", "label", "Full name", "fill", "Dev Viewer");
    await browser("find", "label", "Display name", "fill", "@bot");
    await waitFor(`document.querySelector("main")?.innerText.includes("You can't use this name.")`);
    check(
      "account: a display name starting with @ is refused too",
      await evaluate<boolean>(saveDisabled),
    );
    await browser("find", "label", "Display name", "fill", "  ");

    // A display name equal to the full name is no display name; the name is normalized on save.
    await browser("find", "label", "Full name", "fill", "  Dev   Viewer  Prime ");
    await browser("find", "label", "Display name", "fill", "Dev Viewer Prime");
    await browser("eval", `${mainButton("Save")}.click()`);
    await waitFor(saved);
    let viewer = await db.user.findUniqueOrThrow({ where: { id: DEV_BROWSER_USER.id } });
    check(
      "account: the full name is stored trimmed and single-spaced",
      viewer.fullName === "Dev Viewer Prime",
    );
    check(
      "account: a display name equal to the full name is stored as none",
      viewer.displayName === null,
    );

    // A real nickname replaces the full name wherever a person is shown.
    await browser("eval", `${mainButton("Edit")}.click()`);
    await waitFor(nameFields);
    await browser("find", "label", "Display name", "fill", "Dee");
    await browser("eval", `${mainButton("Save")}.click()`);
    await waitFor(saved);
    viewer = await db.user.findUniqueOrThrow({ where: { id: DEV_BROWSER_USER.id } });
    check("account: a display name is stored", viewer.displayName === "Dee");
    check("account: saving it keeps the full name", viewer.fullName === "Dev Viewer Prime");
    await shoot("settings-profile-saved");

    // Settings → Members: people by their names and no @username; the Invite dialog holds the
    // join link alone.
    await browser("open", `${base}/settings?section=members`);
    await waitFor(`Boolean(document.querySelector('main ul[aria-label="Members"] li'))`);
    text = await mainText();
    for (const name of ["Ada Lovelace", "Amazing Grace", "Dee"])
      check(`members panel: lists ${name}`, text.includes(name));
    check("members panel: shows no username", showsNoUsername(text));
    check("members panel: no row carries an @handle", !/@[a-z0-9-]/i.test(text));
    check("members panel: has no pending invitations section", !/Pending invitations/.test(text));
    await shoot("settings-members");

    await waitFor(hydrated(mainButton("Invite")));
    await browser("eval", `${mainButton("Invite")}.click()`);
    await waitFor(`document.querySelector('[role="dialog"] input')?.value?.includes("/join/")`);
    const dialog = await evaluate<{ text: string; tabs: number }>(
      `({ text: document.querySelector('[role="dialog"]').innerText, tabs: document.querySelectorAll('[role="dialog"] [role="tab"]').length })`,
    );
    check(
      "invite dialog: has no tabs and no invite by username",
      dialog.tabs === 0 && !/username/i.test(dialog.text),
    );
    await shoot("invite-dialog");
    await browser("press", "Escape");

    // The Members directory: a card carries a name only.
    await browser("open", `${base}/members?memberType=human`);
    await waitFor(`document.querySelectorAll('main [role="row"] h2').length >= 3`);
    text = await mainText();
    check(
      "members directory: lists people by name",
      ["Ada Lovelace", "Amazing Grace"].every((name) => text.includes(name)),
    );
    check("members directory: shows no username", showsNoUsername(text));
    check("members directory: no card carries an @handle", !/@[a-z0-9-]/i.test(text));
    await shoot("members-directory");

    // A channel's members page: the roster and the add view search names, not usernames.
    await browser("open", `${base}/channel/${channel.id}`);
    await waitFor(`document.querySelector('[aria-label="Channel details and settings"]') !== null`);
    const panel = `document.querySelector('[role="dialog"][aria-label="Channel details and settings"]')`;
    const panelText = () => evaluate<string>(`${panel}?.innerText ?? ""`);
    const roster = `${panel}?.querySelector('input[placeholder="Search members…"]') != null`;
    // A click that lands before the page hydrates opens nothing; try again until the panel opens.
    for (let attempt = 0; ; attempt += 1) {
      await browser("click", '[aria-label="Channel details and settings"]');
      const opened = await waitFor(`${panel} !== null`).then(
        () => true,
        () => false,
      );
      if (opened) break;
      if (attempt === 5) throw new Error("the channel settings panel never opened");
    }
    await browser(
      "eval",
      `[...${panel}.querySelectorAll("button")].find((button) => /3 humans/.test(button.textContent)).click()`,
    );
    await waitFor(roster);
    await waitFor(`${panel}.innerText.includes("Ada Lovelace")`);
    text = await panelText();
    for (const name of ["Ada Lovelace", "Amazing Grace", "Dee"])
      check(`channel roster: lists ${name}`, text.includes(name));
    check("channel roster: shows no username", showsNoUsername(text));
    check("channel roster: no row carries an @handle", !/@[a-z0-9-]/i.test(text));
    check(
      "channel roster: the viewer's own row offers no role change, another member's does",
      await evaluate<boolean>(
        `${panel}.querySelector('[aria-label="Make Ada Lovelace a channel admin"]') !== null && ${panel}.querySelector('[aria-label="Make Dee a channel admin"], [aria-label="Remove channel admin from Dee"]') === null`,
      ),
    );
    await shoot("channel-roster");
    const search = async (query: string) => {
      await browser("fill", 'input[placeholder="Search members…"]', query);
      await waitFor(
        query.includes("zq7k")
          ? `${panel}.innerText.includes("No matches")`
          : `!${panel}.innerText.includes("No matches") && ${panel}.querySelectorAll('[aria-label^="Make "]').length <= 1`,
      );
      return panelText();
    };
    text = await search("lovelace");
    check(
      "channel roster: a person is found by their full name",
      text.includes("Ada Lovelace") && !text.includes("Amazing Grace"),
    );
    text = await search("hopper");
    check(
      "channel roster: a nickname does not hide the full name from search",
      text.includes("Amazing Grace") && !text.includes("Ada Lovelace"),
    );
    text = await search("zq7k");
    check("channel roster: a username finds nobody", /No matches/.test(text));

    // The add view offers Lin, who is in the Workspace and not in the channel.
    await browser("fill", 'input[placeholder="Search members…"]', "");
    await browser(
      "eval",
      `[...${panel}.querySelectorAll("button")].find((button) => button.textContent.trim() === "Add member").click()`,
    );
    await waitFor(`${panel}.innerText.includes("Add selected (0)")`);
    await waitFor(`${panel}.innerText.includes("Lindy")`);
    text = await panelText();
    check("channel add view: lists the person by label", text.includes("Lindy"));
    check(
      "channel add view: shows no username",
      showsNoUsername(text) && !/@[a-z0-9-]/i.test(text),
    );
    await shoot("channel-add-view");
    await browser("fill", 'input[placeholder="Name"]', "chen");
    await waitFor(`${panel}.innerText.includes("Lindy")`);
    check(
      "channel add view: a person is found by their full name",
      (await panelText()).includes("Lindy"),
    );
    await browser("fill", 'input[placeholder="Name"]', "zq7k");
    await waitFor(`${panel}.innerText.includes("No matches")`);
    check("channel add view: a username finds nobody", !(await panelText()).includes("Lindy"));

    // Search: the From filter and a remembered direct message name people by their names alone;
    // an Agent keeps its `@handle`, which is how it is mentioned.
    const agentHandle = `e2e-hide-bot-${uid}`;
    const agent = await db.agent.create({
      data: {
        workspaceId,
        ownerId: DEV_BROWSER_USER.id,
        name: agentHandle,
        displayName: "Hide Bot",
        runtimeConfig: {
          runtime: "claude-code",
          provider: { kind: "default" },
          model: "claude-opus-4-6",
          modelProvider: "",
          reasoning: "high",
        },
      },
    });
    const direct = await db.conversation.create({
      data: { workspaceId, directKey: peopleDirectKey(DEV_BROWSER_USER.id, people[0]!.id) },
    });
    await db.conversationMember.createMany({
      data: [DEV_BROWSER_USER.id, people[0]!.id].map((userId) => ({
        conversationId: direct.id,
        workspaceId: workspaceId!,
        userId,
      })),
    });
    const usageKey = `coforge:search-usage:${workspaceId}:${DEV_BROWSER_USER.id}`;
    const usage = {
      [`dm:${direct.id}`]: [Date.now() - 1000],
      [`agent:${agent.id}`]: [Date.now() - 2000],
    };
    await browser("open", `${base}/search`);
    await browser(
      "eval",
      `localStorage.clear(); localStorage.setItem(${JSON.stringify(usageKey)}, ${JSON.stringify(JSON.stringify(usage))})`,
    );
    await browser("open", `${base}/search`);
    const frequent = '[aria-labelledby="search-frequent-heading"] [data-search-entity]';
    await waitFor(`document.querySelectorAll(${JSON.stringify(frequent)}).length === 2`);
    const cards = await evaluate<Record<string, string>>(
      `Object.fromEntries([...document.querySelectorAll(${JSON.stringify(frequent)})].map((card) => [card.dataset.searchEntity, card.innerText]))`,
    );
    const dmCard = cards[`dm:${direct.id}`] ?? "";
    check(
      "search home: a direct message card is named by the person",
      dmCard.includes("Ada Lovelace"),
    );
    check(
      "search home: a direct message card shows no username or @handle",
      showsNoUsername(dmCard) && !dmCard.includes("@"),
    );
    check(
      "search home: an Agent card keeps its @handle",
      (cards[`agent:${agent.id}`] ?? "").includes(`@${agentHandle}`),
    );
    await shoot("search-home");

    // The From filter lists people by name with no addon, and finds them by name only.
    const fromChip = `[...document.querySelectorAll('[aria-label="Search filters"] button')].find((button) => button.textContent.trim().startsWith("From"))`;
    await waitFor(hydrated(fromChip));
    await browser("eval", `${fromChip}.click()`);
    const fromField = 'input[placeholder="Find a person or Agent"]';
    const fromOptions = () =>
      evaluate<string[]>(
        `[...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')].map((item) => item.textContent.trim())`,
      );
    await waitFor(`document.querySelectorAll('[role="menuitemradio"]').length >= 5`);
    let options = await fromOptions();
    for (const name of ["Ada Lovelace", "Amazing Grace", "Lindy", "Hide Bot"])
      check(
        `from filter: lists ${name}`,
        options.some((option) => option.includes(name)),
      );
    // A row is an avatar initial, then the name, then an addon: the Agents' `@handle`.
    const personRows = options.filter((option) =>
      /Ada Lovelace|Amazing Grace|Lindy|Me$/.test(option),
    );
    check("from filter: shows no username", showsNoUsername(options.join(" ")));
    check(
      "from filter: a person's row carries no @handle",
      personRows.length === 4 && personRows.every((option) => !option.includes("@")),
    );
    check(
      "from filter: an Agent keeps its @handle",
      options.some((option) => option.includes(`@${agentHandle}`)),
    );
    await shoot("search-from-filter");
    const findSender = async (query: string) => {
      await browser("fill", fromField, query);
      // The list filters as it is typed; wait for it to settle on the expected rows.
      await new Promise((resolve) => setTimeout(resolve, 400));
      return fromOptions();
    };
    options = await findSender("lovelace");
    check(
      "from filter: a person is found by their full name",
      options.some((option) => option.includes("Ada Lovelace")) &&
        !options.some((option) => option.includes("Amazing Grace")),
    );
    options = await findSender("hopper");
    check(
      "from filter: a nickname does not hide the full name from search",
      options.some((option) => option.includes("Amazing Grace")),
    );
    options = await findSender("zq7k");
    check(
      "from filter: a username finds nobody",
      !options.some((option) => /Ada|Grace|Lindy|Me/.test(option)),
    );
    options = await findSender("bot");
    check(
      "from filter: an Agent is found by its handle too",
      options.some((option) => option.includes("Hide Bot")),
    );
    await browser("press", "Escape");

    // A username typed into the search box names no person or place.
    await browser("open", `${base}/search?q=zq7k`);
    await waitFor(`document.querySelector("main")?.innerText.includes("zq7k")`);
    await waitFor(`!document.querySelector('[aria-busy="true"]')`);
    const entityCards = await evaluate<string[]>(
      `[...document.querySelectorAll("main [data-search-entity]")].map((card) => card.dataset.searchEntity)`,
    );
    check(
      "search: a username matches no person, direct message or place",
      entityCards.length === 0,
    );
  } finally {
    await browser("close").catch(() => undefined);
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      join(artifacts, "summary.json"),
      `${JSON.stringify(
        {
          test: "e2e-hide-usernames",
          origin,
          workspace: slug,
          passed: checks.length > 0 && checks.every((entry) => entry.passed),
          checks,
          screenshots,
        },
        null,
        2,
      )}\n`,
    ).catch(() => undefined);
    if (workspaceId) await db.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: memberIds } } }).catch(() => {});
    if (viewerBefore)
      await db.user
        .update({
          where: { id: viewerBefore.id },
          data: { fullName: viewerBefore.fullName, displayName: viewerBefore.displayName },
        })
        .catch(() => {});
    else await db.user.deleteMany({ where: { id: DEV_BROWSER_USER.id } }).catch(() => {});
    await db.$disconnect();
  }
}, 180_000);
