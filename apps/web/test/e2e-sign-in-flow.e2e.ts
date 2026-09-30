import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { workspaceJoinLinks } from "#src/server/workspaces/join-links-store.server";
import {
  hydrated,
  nameField,
  onNameStep,
  openBrowser,
  removeSignInAccounts,
  requireLocalServices,
  seededUuid,
  startSignInStack,
  type Person,
} from "./e2e-sign-in-harness";

/**
 * Signing in through the hosted login page, end to end, from a Workspace invite link. A signed-out
 * visitor signs in, gives the full name a first sign-in asks for, and comes back to the link to
 * join; "Use another account" signs out and comes back to the same link as the other account; a
 * sign-in that does not finish says so and signs in again to the same link; an account with no
 * email address (a phone-number sign-up) signs in like any other; two tabs signing in at once both
 * finish; and a sign-in's own state cookie never passes as a session.
 *
 * Opt-in like the other browser E2Es, but it brings its own servers (`e2e-sign-in-harness.ts`): a
 * stand-in for Authing's OIDC endpoints and a Web dev server with real sign-in pointed at it. It
 * needs `agent-browser`, `openssl`, the local dev database and a local Redis, and deletes what it
 * created. Screenshots and the Web server's log are written under `.amp/e2e/sign-in-flow/`.
 *
 *   REDIS_URL=redis://127.0.0.1:6380 bun test ./test/e2e-sign-in-flow.e2e.ts
 */
const { databaseUrl } = requireLocalServices();
const webPort = Number(Bun.env.COFORGE_E2E_SIGN_IN_WEB_PORT ?? 8798);
const artifacts = join(import.meta.dir, "../../../.amp/e2e/sign-in-flow");

const people = {
  alice: { sub: "e2e-sign-in-alice", email: "e2e-alice@coforge.test", name: "Alice E2E" },
  bob: { sub: "e2e-sign-in-bob", email: "e2e-bob@coforge.test", name: "Bob E2E" },
  // A phone-number sign-up: Authing reports no email.
  "phone-only": { sub: "e2e-sign-in-phone-only", name: "Phone Only E2E" },
  // Authing refuses this account's userinfo request, so its sign-in cannot finish.
  refused: { sub: "e2e-sign-in-refused", name: "Refused E2E", refused: true },
} satisfies Record<string, Person>;
type PersonKey = keyof typeof people;

test("signing in through the hosted page, from a Workspace invite link", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  let stack: Awaited<ReturnType<typeof startSignInStack<PersonKey>>> | undefined;
  const session = `sign-in-flow-${process.pid}`;
  const { browser, boundTabId, evaluate, waitFor, button, submitName } = openBrowser(session);

  const ownerId = seededUuid("e2e-sign-in-flow:owner");
  const slug = "e2e-sign-in-flow";
  const name = "Sign-in Flow Team";
  const subjects = Object.values(people).map((person) => person.sub);
  /** Removes the test accounts, the Workspaces their first sign-in made, and the invited one. */
  const removeSeeded = () => removeSignInAccounts(db, subjects, [ownerId]);
  const userIdOf = async (person: PersonKey) =>
    (
      await db.userIdentity.findUniqueOrThrow({
        where: {
          provider_providerSubject: { provider: "authing", providerSubject: people[person].sub },
        },
      })
    ).userId;

  try {
    stack = await startSignInStack({ people, webPort, artifacts });
    const { origin, fake } = stack;
    const onAuthingPage = `location.origin === ${JSON.stringify(new URL(fake.issuer).origin)} && !!document.querySelector("#as-alice")`;
    const onNameStepHere = onNameStep(origin);
    /** The first-sign-in name step: what it starts with, then the answer. */
    async function answerNameStep(fullName: string, prefilledWith: string) {
      await waitFor(onNameStepHere);
      expect(await evaluate<string>(`${nameField}.value`)).toBe(prefilledWith);
      await submitName(fullName);
    }

    // A leftover from an interrupted run starts over.
    await removeSeeded();
    await db.user.upsert({
      where: { id: ownerId },
      create: {
        id: ownerId,
        username: "e2e-sign-in-owner",
        fullName: "Sign-in Owner",
      },
      update: {},
    });
    const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
      slug,
      name,
      userId: ownerId,
    });
    const link = await workspaceJoinLinks(db).create({
      workspaceId: workspace.id,
      actorUserId: ownerId,
      maxUses: null,
      expiresAt: null,
    });
    const joinPath = `/join/${link.token}`;
    /** The invite page, signed in and naming the account `account` (its email, or its name). */
    const onJoinPageAs = (account: string) =>
      `location.origin === ${JSON.stringify(origin)} && location.pathname.endsWith(${JSON.stringify(joinPath)}) && document.querySelector("main")?.innerText.includes(${JSON.stringify(`Signed in as ${account}`)})`;

    // A sign-in's state cookie replayed as the session signs nobody in; the session it ends in does.
    const started = await fetch(`${origin}/auth/login?returnTo=${encodeURIComponent(joinPath)}`, {
      redirect: "manual",
    });
    const stateCookie = started.headers.getSetCookie()[0]?.split(";", 1)[0];
    if (!stateCookie) throw new Error("sign-in set no state cookie");
    const authorize = new URL(started.headers.get("location") ?? "");
    expect(authorize.origin + authorize.pathname).toBe(`${fake.issuer}/auth`);
    const stateValue = stateCookie.slice(stateCookie.indexOf("=") + 1);
    expect(
      (await fetch(`${origin}/api/me`, { headers: { cookie: `coforge_session=${stateValue}` } }))
        .status,
    ).toBe(401);
    const callback = await fetch(fake.approve("alice", authorize.searchParams), {
      headers: { cookie: stateCookie },
      redirect: "manual",
    });
    // A first sign-in is asked for a full name before anything is made, and comes back to the link.
    expect(callback.headers.get("location")).toBe(
      `/en/welcome?returnTo=${encodeURIComponent(joinPath)}`,
    );
    const sessionCookie = callback.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("coforge_session="))
      ?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("the callback set no session cookie");
    const me = await fetch(`${origin}/api/me`, { headers: { cookie: sessionCookie } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe(people.alice.email);

    // An account with no email signs in the same way, and is left without one.
    const phoneStarted = await fetch(
      `${origin}/auth/login?returnTo=${encodeURIComponent(joinPath)}`,
      { redirect: "manual" },
    );
    const phoneStateCookie = phoneStarted.headers.getSetCookie()[0]?.split(";", 1)[0];
    if (!phoneStateCookie) throw new Error("sign-in set no state cookie");
    const phoneCallback = await fetch(
      fake.approve("phone-only", new URL(phoneStarted.headers.get("location") ?? "").searchParams),
      { headers: { cookie: phoneStateCookie }, redirect: "manual" },
    );
    expect(phoneCallback.headers.get("location")).toBe(
      `/en/welcome?returnTo=${encodeURIComponent(joinPath)}`,
    );
    const phoneSessionCookie = phoneCallback.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("coforge_session="))
      ?.split(";", 1)[0];
    if (!phoneSessionCookie) throw new Error("the callback set no session cookie");
    const phoneMe = await fetch(`${origin}/api/me`, { headers: { cookie: phoneSessionCookie } });
    expect(phoneMe.status).toBe(200);
    const phoneUser = ((await phoneMe.json()) as { user: Record<string, unknown> }).user;
    expect(phoneUser.email).toBeNull();
    // The session keeps what the provider reported, only to start the name field with.
    expect(phoneUser.name).toBe(people["phone-only"].name);
    // With no email or preferred_username the profile name names the account, never a phone number.
    expect(phoneUser.username).toMatch(/^phone-only-e2e(-\d+)?$/);
    // Nothing was made for either of them yet: their Workspace waits for the name.
    for (const person of ["alice", "phone-only"] as const) {
      const userId = await userIdOf(person);
      expect(await db.workspaceMembership.count({ where: { userId } })).toBe(0);
      expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).fullName).toBeNull();
    }

    await browser("set", "viewport", "1440", "900");
    await mkdir(artifacts, { recursive: true });

    // Signed out, the invite link offers to sign in, and signing in comes back to it to join.
    await browser("open", `${origin}/en${joinPath}`);
    await waitFor(hydrated(button("Sign in to join")));
    await browser("screenshot", join(artifacts, "1-signed-out-invite.png"));
    await browser("eval", `${button("Sign in to join")}.click()`);
    await waitFor(onAuthingPage);
    await browser("click", "#as-alice");
    // A first sign-in is asked for a full name, starting from the provider's own.
    await waitFor(onNameStepHere);
    await browser("screenshot", join(artifacts, "1b-name-step.png"));
    await answerNameStep("Alice E2E", people.alice.name);
    await waitFor(onJoinPageAs(people.alice.email));
    await waitFor(hydrated(button(`Join ${name}`)));
    await browser("screenshot", join(artifacts, "2-back-on-invite-as-alice.png"));
    await browser("eval", `${button(`Join ${name}`)}.click()`);
    // The URL changes before the Workspace renders, so wait for its #general and no error page.
    await waitFor(
      `location.pathname.includes("/w/${slug}") && !${button(`Join ${name}`)} && document.body.innerText.includes("#general") && !document.body.innerText.includes("could not be loaded")`,
    );
    const alice = await userIdOf("alice");
    expect(
      (
        await db.workspaceMembership.findUniqueOrThrow({
          where: { workspaceId_userId: { workspaceId: workspace.id, userId: alice } },
        })
      ).role,
    ).toBe("member");
    const general = await db.conversation.findUniqueOrThrow({
      where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
    });
    expect(
      await db.conversationMember.count({
        where: { conversationId: general.id, userId: alice, leftAt: null },
      }),
    ).toBe(1);
    // Answering the name step made Alice's own Workspace too, titled with the name she gave.
    const own = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: alice, role: "owner" },
      include: { workspace: true },
    });
    expect(own.workspace.name).toBe("Alice E2E's Workspace");
    await browser("screenshot", join(artifacts, "3-joined-as-alice.png"));

    // "Use another account" signs out at Authing and comes back to the same link as the other
    // account, which has not joined yet.
    await browser("open", `${origin}/en${joinPath}`);
    await waitFor(hydrated(button("Use another account")));
    expect(await evaluate<boolean>(`!!${button(`Open ${name}`)}`)).toBe(true);
    await browser("eval", `${button("Use another account")}.click()`);
    await waitFor(onAuthingPage);
    expect(fake.endedSessions.at(-1)).toBe("id-alice");
    await browser("click", "#as-bob");
    await waitFor(onNameStepHere);
    await answerNameStep("Bob E2E", people.bob.name);
    await waitFor(onJoinPageAs(people.bob.email));
    expect(await evaluate<boolean>(`!!${button(`Join ${name}`)}`)).toBe(true);
    await browser("screenshot", join(artifacts, "4-switched-to-bob.png"));

    // A sign-in that does not finish says so on this site, and signing in again returns to the link.
    await browser("cookies", "clear");
    await browser("open", `${origin}/auth/login?returnTo=${encodeURIComponent(joinPath)}`);
    await waitFor(onAuthingPage);
    await browser("click", "#as-refused");
    await waitFor(
      `location.origin === ${JSON.stringify(origin)} && document.querySelector("main [role=alert]")?.textContent === "Sign-in failed. Try again."`,
    );
    expect(await evaluate<string>(`new URL(location.href).searchParams.get("returnTo")`)).toBe(
      joinPath,
    );
    await browser("screenshot", join(artifacts, "5-sign-in-failed.png"));
    await browser("eval", `${button("Sign in again")}.click()`);
    await waitFor(onAuthingPage);
    await browser("click", "#as-bob");
    // Bob has answered already: he is not asked again.
    await waitFor(onJoinPageAs(people.bob.email));

    // An account with no email is signed in, not signed out: after the name step the invite offers
    // to join it, and names the account by the name it gave, never by an @username.
    await browser("cookies", "clear");
    await browser("open", `${origin}/auth/login?returnTo=${encodeURIComponent(joinPath)}`);
    await waitFor(onAuthingPage);
    await browser("click", "#as-phone-only");
    await answerNameStep("Phone Only E2E", people["phone-only"].name);
    await waitFor(onJoinPageAs("Phone Only E2E"));
    expect(await evaluate<boolean>(`!!${button(`Join ${name}`)}`)).toBe(true);
    expect(await evaluate<boolean>(`!!${button("Sign in to join")}`)).toBe(false);
    expect(await evaluate<boolean>(`document.body.innerText.includes("@")`)).toBe(false);
    await browser("screenshot", join(artifacts, "6-signed-in-without-email.png"));

    // Two tabs signing in at the same time both finish: each sign-in keeps its own state.
    await browser("cookies", "clear");
    await browser("open", `${origin}/auth/login?returnTo=${encodeURIComponent(joinPath)}`);
    await waitFor(onAuthingPage);
    const firstTab = await boundTabId();
    await browser("tab", "new");
    await browser("open", `${origin}/auth/login?returnTo=${encodeURIComponent(joinPath)}`);
    await waitFor(onAuthingPage);
    await browser("click", "#as-bob");
    await waitFor(onJoinPageAs(people.bob.email));
    await browser("tab", firstTab);
    await waitFor(onAuthingPage);
    await browser("click", "#as-alice");
    await waitFor(onJoinPageAs(people.alice.email));
    await browser("screenshot", join(artifacts, "7-first-tab-finished-as-alice.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await stack?.stop();
    await removeSeeded();
    await db.$disconnect();
  }
}, 240_000);
