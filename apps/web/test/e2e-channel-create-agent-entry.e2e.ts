import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * Creating an Agent from a channel's add view, in a real browser. A search that matches nobody
 * offers "Create Agent “<search>”", which says the Agent joins the channel once created. It opens
 * the Agent form with that name filled in and the visibility held at Public (a private Agent can
 * never be in a channel); creating the Agent adds it to the channel and returns the list to
 * every candidate. A refused create (the name is taken) shows its reason in the form, and a
 * member who may not create Agents sees why in place of the entry.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user an owner of
 * its Workspace with a Computer attached (seed-dev). Each run seeds a fresh channel and removes it
 * and the Agent afterwards. Screenshots are written under `.amp/e2e/channel-create-agent-entry/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/channel-create-agent-entry");

test("the add view creates an Agent named by the search, and it joins the channel", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `channel-create-agent-${process.pid}`;
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
    `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((element) => element.textContent.trim().startsWith(${JSON.stringify(text)})).at(-1)`;
  async function clickText(selector: string, text: string) {
    await waitFor(`${byText(selector, text)} !== undefined`);
    await browser("eval", `${byText(selector, text)}.click()`);
  }
  const panel = `document.querySelector('[role="dialog"][aria-label="Channel details and settings"]')`;
  const panelHas = (text: string) => `${panel}?.textContent.includes(${JSON.stringify(text)})`;
  const agentForm = `[...document.querySelectorAll('[role="dialog"]')].find((dialog) => dialog.querySelector('input[name="name"]'))`;

  async function openPanel() {
    await waitFor(
      `document.querySelector('[aria-label="Channel details and settings"]') !== null`,
      60_000,
    );
    // A click that lands before the page hydrates opens nothing; try again until the panel opens.
    for (let attempt = 0; ; attempt += 1) {
      await browser("click", '[aria-label="Channel details and settings"]');
      const opened = await waitFor(`${panel} !== null`, 5_000).then(
        () => true,
        () => false,
      );
      if (opened) break;
      if (attempt === 5) throw new Error("the channel settings panel never opened");
    }
  }
  /** The seeded Computer's Claude Code needs no API key, unlike the default runtime. */
  async function chooseClaudeCode() {
    await browser(
      "eval",
      `[...${agentForm}.querySelectorAll("button")].find((button) => button.textContent.trim() === "CoForge").click()`,
    );
    await waitFor(
      `[...document.querySelectorAll('[role="option"]')].some((option) => option.textContent.includes("Claude Code"))`,
    );
    await browser(
      "eval",
      `[...document.querySelectorAll('[role="option"]')].find((option) => option.textContent.includes("Claude Code")).click()`,
    );
    await waitFor(
      `[...${agentForm}.querySelectorAll("button")].some((button) => button.textContent.trim() === "Claude Code")`,
    );
  }

  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
  });
  const workspaceId = membership.workspaceId;
  const channel = await db.conversation.create({
    data: { workspaceId, channelName: `e2e-create-agent-${process.pid}`, description: "" },
  });
  const agentName = `e2e-joined-${process.pid}`;
  try {
    await db.conversationMember.create({
      data: {
        conversationId: channel.id,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        channelRole: "admin",
      },
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/messages/channels/${channel.id}`);
    await waitFor(
      `document.querySelector('[aria-label="Channel details and settings"]') !== null`,
      60_000,
    );
    await openPanel();

    // "+" opens the add view, which always ends with the create entry.
    await waitFor(`${panel}?.querySelector('[aria-label="Add members"]') != null`);
    await browser("eval", `${panel}.querySelector('[aria-label="Add members"]').click()`);
    await waitFor(panelHas("Add selected (0)"));
    await waitFor(panelHas("Create a new Agent"));
    expect(
      await evaluate<boolean>(
        panelHas(`Joins #${channel.channelName} automatically after it is created`),
      ),
    ).toBe(true);

    // A search that matches nobody names the Agent to create.
    await browser("fill", 'input[placeholder="Name"]', agentName);
    await waitFor(panelHas(`No matches for “${agentName}”`));
    await waitFor(panelHas(`Create Agent “${agentName}”`));
    await browser("screenshot", join(artifacts, "entry.png"));

    // It opens the Agent form with that name, and the visibility cannot leave Public.
    await clickText(`[role="dialog"] button`, `Create Agent “${agentName}”`);
    await waitFor(`${agentForm} !== undefined`);
    await waitFor(
      `${agentForm}.textContent.includes(${JSON.stringify(`Joins #${channel.channelName} automatically after it is created.`)})`,
    );
    const form = await evaluate<{ name: string; visibilityDisabled: boolean }>(`(() => {
      const dialog = ${agentForm};
      const visibility = [...dialog.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.startsWith("Visibility"));
      return {
        name: dialog.querySelector('input[name="name"]').value,
        visibilityDisabled: visibility?.disabled === true || visibility?.getAttribute("data-disabled") === "true",
      };
    })()`);
    expect(form).toEqual({ name: agentName, visibilityDisabled: true });
    await browser("screenshot", join(artifacts, "form.png"));

    await chooseClaudeCode();

    // Creating it adds it to the channel and clears the search.
    await clickText(`[role="dialog"] button`, "Create agent");
    await waitFor(`${agentForm} === undefined`);
    await waitFor(`!${panelHas(`No matches for “${agentName}”`)}`);
    const created = await db.agent.findFirstOrThrow({ where: { workspaceId, name: agentName } });
    expect(created.visibility).toBe("public");
    expect(
      await db.conversationMember.findFirst({
        where: { conversationId: channel.id, agentId: created.id, leftAt: null },
      }),
    ).not.toBeNull();
    expect(
      await evaluate<string>(`${panel}.querySelector('input[placeholder="Name"]').value`),
    ).toBe("");
    await browser("screenshot", join(artifacts, "joined.png"));

    // The name is taken now: the form says so and the page stays up.
    await browser("fill", 'input[placeholder="Name"]', agentName);
    await clickText(`[role="dialog"] button`, `Create Agent “${agentName}”`);
    await waitFor(`${agentForm} !== undefined`);
    await chooseClaudeCode();
    await clickText(`[role="dialog"] button`, "Create agent");
    await waitFor(`${agentForm}?.querySelector('[role="alert"]')?.textContent.trim().length > 0`);
    expect(await evaluate<boolean>(`${panel} !== null`)).toBe(true);
    await browser("screenshot", join(artifacts, "refused.png"));
    await clickText(`[role="dialog"] button`, "Cancel");
    await waitFor(`${agentForm} === undefined`);
    expect(await db.agent.count({ where: { workspaceId, name: agentName } })).toBe(1);

    // A member who may not create Agents sees why instead of the entry.
    await db.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId, userId: DEV_BROWSER_USER.id } },
      data: { role: "member" },
    });
    await browser("open", `${origin}/en/messages/channels/${channel.id}`);
    await openPanel();
    await waitFor(`${panel}?.querySelector('[aria-label="Add members"]') != null`);
    await browser("eval", `${panel}.querySelector('[aria-label="Add members"]').click()`);
    await waitFor(panelHas("only a Workspace owner or admin can create Agents"));
    expect(
      await evaluate<boolean>(
        `[...${panel}.querySelectorAll("button")].some((button) => button.textContent.startsWith("Create a new Agent"))`,
      ),
    ).toBe(false);
    await browser("screenshot", join(artifacts, "denied.png"));
  } finally {
    await db.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId, userId: DEV_BROWSER_USER.id } },
      data: { role: "owner" },
    });
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => {});
    // Not caught: an Agent left behind would make the next run's name check lie.
    await db.agent.deleteMany({ where: { workspaceId, name: agentName } });
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
