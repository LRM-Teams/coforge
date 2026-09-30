import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import {
  nameField,
  nameFieldSelector,
  onNameStep,
  openBrowser,
  removeSignInAccounts,
  requireLocalServices,
  startSignInStack,
  type Person,
} from "./e2e-sign-in-harness";

/**
 * The first sign-in's full-name step, end to end, against real sign-in (a stand-in for Authing's
 * OIDC endpoints and a Web dev server signed in through it, `e2e-sign-in-harness.ts`).
 *
 * - A new person is asked for a full name at `/welcome`, starting from what the provider reported,
 *   before anything is made for them. Empty and too-long names are refused inline. Submitting
 *   lands in the app in a personal Workspace titled with the full name they gave, and they are not
 *   asked again.
 * - A phone-number sign-up starts with an empty field (a number is not a name), in Chinese, on a
 *   phone-width screen.
 * - An existing person with no full name is asked once and keeps the Workspace they have.
 * - An existing session (one that predates the step) opening a Workspace page is sent to the name
 *   step and back, while `/oauth/verify` (Computer device approval) is not gated.
 *
 * Opt-in like the other browser E2Es, and it needs `agent-browser`, `openssl`, the local dev
 * database and a local Redis; it deletes what it created. It leaves a repeatable artifact in
 * `.amp/e2e/first-sign-in-name/`: screenshots (the page at 1440 px and 390 px among them), the Web
 * server's log and `summary.json`.
 *
 *   REDIS_URL=redis://127.0.0.1:6380 bun test ./test/e2e-first-sign-in-name.e2e.ts
 */
const { databaseUrl } = requireLocalServices();
const webPort = Number(Bun.env.COFORGE_E2E_FIRST_SIGN_IN_WEB_PORT ?? 8795);
const artifacts = join(import.meta.dir, "../../../.amp/e2e/first-sign-in-name");

const people = {
  // Signs in for the first time with a provider name that reads as a name.
  newcomer: {
    sub: "e2e-fsn-newcomer",
    email: "e2e-fsn-newcomer@coforge.test",
    name: "Grace Hopper E2E",
  },
  // A phone-number sign-up: no email, and the provider's "name" is the number.
  phone: { sub: "e2e-fsn-phone", name: "13800138000" },
  // Has a Workspace and no full name: an account that predates the step. The provider reports no
  // name, only a nickname, which starts the field instead.
  existing: {
    sub: "e2e-fsn-existing",
    email: "e2e-fsn-existing@coforge.test",
    nickname: "Existing Person",
  },
} satisfies Record<string, Person>;
type PersonKey = keyof typeof people;

const existingSlug = "e2e-fsn-existing";
const existingWorkspaceName = "Existing Team";

test("a first sign-in is asked for a full name once, and the personal Workspace is titled with it", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  let stack: Awaited<ReturnType<typeof startSignInStack<PersonKey>>> | undefined;
  const { browser, evaluate, waitFor, button, setInput, submitName } = openBrowser(
    `first-sign-in-name-${process.pid}`,
  );

  const subjects = Object.values(people).map((person) => person.sub);
  const checks: string[] = [];
  const screenshots: string[] = [];
  const facts: Record<string, unknown> = {};
  let failure: string | undefined;
  /** Records a step that held, by what it shows a person or the database. */
  const passed = (name: string) => checks.push(name);
  async function shoot(file: string) {
    await browser("screenshot", join(artifacts, file));
    screenshots.push(file);
  }

  const removeSeeded = () => removeSignInAccounts(db, subjects);
  const userOf = async (person: PersonKey) =>
    db.user.findFirstOrThrow({
      where: { identities: { some: { provider: "authing", providerSubject: people[person].sub } } },
    });
  const membershipsOf = async (person: PersonKey) =>
    db.workspaceMembership.findMany({
      where: { userId: (await userOf(person)).id },
      include: { workspace: true },
    });

  try {
    stack = await startSignInStack({ people, webPort, artifacts });
    const { origin, fake } = stack;
    const onAuthingPage = `location.origin === ${JSON.stringify(new URL(fake.issuer).origin)} && !!document.querySelector("#as-newcomer")`;
    const onNameStepHere = onNameStep(origin);
    // The Workspace has rendered (its `general` channel is listed, in either language) and the page
    // is not the load-error one.
    const inAppAt = (path: string) =>
      `location.origin === ${JSON.stringify(origin)} && location.pathname.includes(${JSON.stringify(path)}) && document.body.innerText.includes("general") && !document.body.innerText.includes("could not be loaded") && !document.body.innerText.includes("页面无法加载")`;
    const fieldError = `(document.querySelector("main form [role=alert]")?.textContent ?? null)`;
    const fieldValue = () => evaluate<string>(`${nameField}.value`);
    /** Whether the page scrolls sideways: it must not, at any width. */
    const overflowsSideways = () =>
      evaluate<boolean>(
        `document.documentElement.scrollWidth > document.documentElement.clientWidth`,
      );
    async function signInAs(person: PersonKey, returnTo?: string) {
      await browser("cookies", "clear");
      await browser(
        "open",
        `${origin}/auth/login${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`,
      );
      await waitFor(onAuthingPage);
      await browser("click", `#as-${person}`);
    }

    await removeSeeded();
    // An account that predates the step: it has a Workspace and no full name.
    const existingUser = await db.user.create({ data: { username: "e2e-fsn-existing" } });
    await db.userIdentity.create({
      data: { userId: existingUser.id, provider: "authing", providerSubject: people.existing.sub },
    });
    await new PrismaWorkspaceCatalogStore(db).createForUser({
      slug: existingSlug,
      name: existingWorkspaceName,
      userId: existingUser.id,
    });
    await mkdir(artifacts, { recursive: true });

    // ── A new person, on a desktop screen ───────────────────────────────────────────────────────
    await browser("set", "viewport", "1440", "900");
    await signInAs("newcomer");
    await waitFor(onNameStepHere);
    expect(new URL(await evaluate<string>("location.href")).pathname).toBe("/en/welcome");
    expect(await evaluate<string>(`document.querySelector("main h1")?.textContent`)).toBe(
      "Enter your full name",
    );
    expect(await evaluate<string>(`document.querySelector("main label")?.innerText`)).toBe(
      "Full name",
    );
    expect(await fieldValue()).toBe("Grace Hopper E2E");
    // Signed in, but nothing is made for them until they answer.
    const newcomer = await userOf("newcomer");
    expect(newcomer.fullName).toBeNull();
    expect(await membershipsOf("newcomer")).toHaveLength(0);
    // The page says nothing else: no subtitle, no "signed in as", no display-name field.
    expect(await evaluate<number>(`document.querySelectorAll("main input").length`)).toBe(1);
    expect(
      await evaluate<string[]>(
        `document.querySelector("main").innerText.split("\\n").map((line) => line.trim()).filter(Boolean)`,
      ),
    ).toEqual(["Enter your full name", "Full name", "Continue"]);
    expect(await overflowsSideways()).toBe(false);
    await shoot("01-name-step-desktop-1440.png");
    passed(
      "a new person is asked for a full name, starting from the provider's name, before anything is made",
    );

    // Empty and too-long names are refused inline, under the field, and nothing is saved.
    await submitName("");
    await waitFor(`${fieldError} === "Enter your full name."`);
    expect(await evaluate<boolean>(`!!document.querySelector("[data-sonner-toast]")`)).toBe(false);
    await shoot("02-empty-error-desktop.png");
    await submitName("a".repeat(81));
    await waitFor(`${fieldError} === "Use 80 characters or fewer."`);
    await shoot("03-too-long-error-desktop.png");
    // A name the rule refuses says so, in its own words: it is not "empty" and not "too long".
    await submitName("@grace");
    await waitFor(`${fieldError} === "You can't use this name."`);
    await shoot("03b-refused-error-desktop.png");
    expect((await userOf("newcomer")).fullName).toBeNull();
    // Typing again takes the problem away.
    await setInput(nameFieldSelector, "Grace");
    await waitFor(`${fieldError} === null`);
    passed("an empty or too-long name is refused inline and saves nothing");

    // Answering makes the personal Workspace, titled with the name as given (normalized).
    // Typed for real, whitespace and all: the field is emptied, then keystrokes fill it.
    await setInput(nameFieldSelector, "");
    await browser("click", nameFieldSelector);
    await browser("keyboard", "type", "  Grace   Hopper ");
    await browser("eval", `${button("Continue")}.click()`);
    await waitFor(inAppAt("/w/"));
    const named = await userOf("newcomer");
    expect(named.fullName).toBe("Grace Hopper");
    const [personal, ...more] = await membershipsOf("newcomer");
    expect(more).toEqual([]);
    expect(personal?.role).toBe("owner");
    expect(personal?.workspace.name).toBe("Grace Hopper's Workspace");
    facts.personalWorkspace = { slug: personal?.workspace.slug, name: personal?.workspace.name };
    await waitFor(`document.body.innerText.includes("This is the start of the channel")`);
    await shoot("04-personal-workspace-desktop.png");
    passed("submitting lands in the app in a personal Workspace titled with the full name given");

    // Signing in again, or opening /welcome, does not ask again.
    await signInAs("newcomer");
    await waitFor(inAppAt("/w/"));
    await browser("open", `${origin}/en/welcome`);
    await waitFor(inAppAt("/w/"));
    expect(await membershipsOf("newcomer")).toHaveLength(1);
    passed("a person who has answered is not asked again");

    // ── A phone-number sign-up, on a phone, in Chinese ──────────────────────────────────────────
    await browser("set", "viewport", "390", "844");
    await signInAs("phone");
    await waitFor(onNameStepHere);
    expect(await fieldValue()).toBe("");
    expect(await overflowsSideways()).toBe(false);
    await shoot("05-name-step-phone-390.png");
    passed("a provider name that is a phone number is not offered, and the page fits a phone");

    await browser("open", `${origin}/zh-CN/welcome`);
    await waitFor(onNameStepHere);
    expect(await evaluate<string>(`document.querySelector("main h1")?.textContent`)).toBe(
      "输入你的全名",
    );
    expect(await evaluate<string>(`document.querySelector("main label")?.innerText`)).toBe("全名");
    await submitName("", "继续");
    await waitFor(`${fieldError} === "请输入你的全名。"`);
    await shoot("06-empty-error-zh-CN-390.png");
    await submitName("安".repeat(81), "继续");
    await waitFor(`${fieldError} === "全名最多 80 个字符。"`);
    expect(await overflowsSideways()).toBe(false);
    await shoot("07-too-long-error-zh-CN-390.png");
    await submitName("@安栋", "继续");
    await waitFor(`${fieldError} === "不能使用这个名字。"`);
    await submitName("安栋", "继续");
    await waitFor(inAppAt("/w/"));
    expect((await userOf("phone")).fullName).toBe("安栋");
    passed("the page and its errors are in Chinese under /zh-CN, and fit a phone");

    // ── An existing person with no full name: asked once, and keeps their Workspace ─────────────
    await browser("set", "viewport", "1440", "900");
    await signInAs("existing", `/w/${existingSlug}`);
    await waitFor(onNameStepHere);
    expect(new URL(await evaluate<string>("location.href")).searchParams.get("returnTo")).toBe(
      `/w/${existingSlug}`,
    );
    expect(await fieldValue()).toBe("Existing Person");
    await shoot("08-existing-account-asked-desktop.png");
    await submitName("Existing Person");
    await waitFor(inAppAt(`/w/${existingSlug}`));
    expect((await userOf("existing")).fullName).toBe("Existing Person");
    const [kept, ...extra] = await membershipsOf("existing");
    expect(extra).toEqual([]);
    expect(kept?.workspace.name).toBe(existingWorkspaceName);
    // Signing in again goes straight to the page: not asked twice.
    await signInAs("existing", `/w/${existingSlug}`);
    await waitFor(inAppAt(`/w/${existingSlug}`));
    passed("an existing account is asked once and keeps the Workspace it has");

    // ── An existing session that predates the step ──────────────────────────────────────────────
    // The session is still valid, and the person has no full name: a page in a Workspace sends
    // them to the name step and back to that page; Computer device approval is not gated.
    await db.user.update({ where: { id: existingUser.id }, data: { fullName: null } });
    await browser("open", `${origin}/en/oauth/verify`);
    await waitFor(
      `location.pathname === "/oauth/verify" && document.body.innerText.includes("Signed in as")`,
    );
    passed("device approval (/oauth/verify) is not gated");
    await browser("open", `${origin}/en/w/${existingSlug}/tasks`);
    await waitFor(onNameStepHere);
    expect(new URL(await evaluate<string>("location.href")).searchParams.get("returnTo")).toBe(
      `/w/${existingSlug}/tasks`,
    );
    await shoot("09-existing-session-sent-to-name-step.png");
    await submitName("Existing Person");
    await waitFor(`location.pathname.endsWith("/w/${existingSlug}/tasks")`);
    expect((await userOf("existing")).fullName).toBe("Existing Person");
    passed("an existing session opening a Workspace page is asked once and returns to that page");

    // ── A session that outlived its user ────────────────────────────────────────────────────────
    // The phone account signs in again by `/welcome` alone: nothing can be saved for a user that no
    // longer exists, so the page does not ask, it sends them to sign in (and a new user is made).
    await signInAs("phone");
    await waitFor(inAppAt("/w/"));
    const phone = await userOf("phone");
    await db.workspace.deleteMany({
      where: { members: { some: { userId: phone.id, role: "owner" } } },
    });
    await db.user.delete({ where: { id: phone.id } });
    await browser("open", `${origin}/en/welcome`);
    await waitFor(onAuthingPage);
    await browser("click", "#as-phone");
    await waitFor(onNameStepHere);
    expect((await userOf("phone")).id).not.toBe(phone.id);
    passed("a session whose user is gone is sent to sign in again, not left on the name step");

    facts.origin = origin;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await browser("close").catch(() => undefined);
    await stack?.stop();
    await removeSeeded().catch(() => undefined);
    await db.$disconnect();
    await mkdir(artifacts, { recursive: true });
    await Bun.write(
      join(artifacts, "summary.json"),
      `${JSON.stringify(
        {
          test: "first sign-in full-name step",
          command: "REDIS_URL=redis://127.0.0.1:6380 bun test ./test/e2e-first-sign-in-name.e2e.ts",
          result: failure === undefined ? "passed" : "failed",
          ...(failure === undefined ? {} : { failure }),
          viewports: ["1440x900 (desktop)", "390x844 (phone)"],
          checks,
          screenshots,
          facts,
        },
        null,
        2,
      )}\n`,
    );
  }
}, 300_000);
