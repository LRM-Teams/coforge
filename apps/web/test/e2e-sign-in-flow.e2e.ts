import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { workspaceJoinLinks } from "#src/server/workspaces/join-links-store.server";

/**
 * Signing in through the hosted login page, end to end, from a Workspace invite link. A signed-out
 * visitor signs in and comes back to the link to join; "Use another account" signs out and comes
 * back to the same link as the other account; a sign-in that does not finish says so and signs in
 * again to the same link; an account with no email address (a phone-number sign-up) signs in like
 * any other; two tabs signing in at once both finish; and a sign-in's own state cookie never passes
 * as a session.
 *
 * Opt-in like the other browser E2Es, but it brings its own servers: a stand-in for Authing's OIDC
 * endpoints over HTTPS (a throwaway self-signed certificate; the Web server trusts it through
 * `NODE_EXTRA_CA_CERTS`, the browser ignores certificate errors), and a Web dev server with real
 * sign-in (`COFORGE_DEV_SKIP_AUTH=0`) pointed at it. It needs `agent-browser`, `openssl`, the
 * local dev database and a local Redis, and deletes what it created. Screenshots and the Web
 * server's log are written under `.amp/e2e/sign-in-flow/`.
 *
 *   REDIS_URL=redis://127.0.0.1:6380 bun test ./test/e2e-sign-in-flow.e2e.ts
 */
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const opensslPath = Bun.which("openssl");
if (!opensslPath) throw new Error("openssl is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
// Workspace pages read Agent and Computer status from Redis.
const redisUrl = Bun.env.REDIS_URL;
if (!redisUrl || new URL(redisUrl).hostname !== "127.0.0.1")
  throw new Error("REDIS_URL must target local Redis");
const webPort = Number(Bun.env.COFORGE_E2E_SIGN_IN_WEB_PORT ?? 8798);
const origin = `http://127.0.0.1:${webPort}`;
const artifacts = join(import.meta.dir, "../../../.amp/e2e/sign-in-flow");

type Person = { sub: string; email?: string; name: string; refused?: true };
const people = {
  alice: { sub: "e2e-sign-in-alice", email: "e2e-alice@coforge.test", name: "Alice E2E" },
  bob: { sub: "e2e-sign-in-bob", email: "e2e-bob@coforge.test", name: "Bob E2E" },
  // A phone-number sign-up: Authing reports no email.
  "phone-only": { sub: "e2e-sign-in-phone-only", name: "Phone Only E2E" },
  // Authing refuses this account's userinfo request, so its sign-in cannot finish.
  refused: { sub: "e2e-sign-in-refused", name: "Refused E2E", refused: true },
} satisfies Record<string, Person>;
type PersonKey = keyof typeof people;
const appId = "e2e-sign-in-app";
const appSecret = "e2e-sign-in-app-secret";

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * The part of Authing's OIDC provider the Web server talks to. Its sign-in page lists the test
 * accounts as links, so the browser picks who signs in. Like Authing, it returns only to the app's
 * registered callback and homepage, and the token endpoint checks the client, the redirect URI and
 * the PKCE verifier.
 */
function startFakeAuthing(tls: { cert: string; key: string }) {
  const registeredCallback = `${origin}/auth/callback`;
  const registeredHomepage = `${origin}/`;
  const codes = new Map<string, { person: PersonKey; challenge: string; redirectUri: string }>();
  const accessTokens = new Map<string, PersonKey>();
  const endedSessions: (string | null)[] = [];

  /** What the sign-in page's "Continue as …" link does: back to the app with a one-time code. */
  function approve(person: PersonKey, authorize: URLSearchParams): string {
    const code = randomBytes(16).toString("base64url");
    const redirectUri = authorize.get("redirect_uri") ?? "";
    codes.set(code, { person, challenge: authorize.get("code_challenge") ?? "", redirectUri });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", authorize.get("state") ?? "");
    return back.toString();
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/oidc/auth") {
        const valid =
          url.searchParams.get("client_id") === appId &&
          url.searchParams.get("redirect_uri") === registeredCallback &&
          url.searchParams.get("response_type") === "code" &&
          url.searchParams.get("code_challenge_method") === "S256" &&
          Boolean(url.searchParams.get("code_challenge") && url.searchParams.get("state"));
        if (!valid) return new Response("invalid authorization request", { status: 400 });
        const links = (Object.keys(people) as PersonKey[])
          .map((key) => {
            const next = new URLSearchParams(url.searchParams);
            next.set("person", key);
            return `<li><a id="as-${key}" href="/oidc/approve?${next}">Continue as ${people[key].name}</a></li>`;
          })
          .join("");
        return new Response(`<!doctype html><title>Fake Authing</title><ul>${links}</ul>`, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/oidc/approve") {
        const person = url.searchParams.get("person") as PersonKey;
        return Response.redirect(approve(person, url.searchParams), 302);
      }
      if (url.pathname === "/oidc/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        const issued = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (
          !issued ||
          form.get("grant_type") !== "authorization_code" ||
          form.get("client_id") !== appId ||
          form.get("client_secret") !== appSecret ||
          form.get("redirect_uri") !== issued.redirectUri ||
          challenge !== issued.challenge
        ) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const accessToken = randomBytes(16).toString("base64url");
        accessTokens.set(accessToken, issued.person);
        return Response.json({ access_token: accessToken, id_token: `id-${issued.person}` });
      }
      if (url.pathname === "/oidc/me") {
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        const person = accessTokens.get(token);
        const profile: Person | undefined = person && people[person];
        return profile && !profile.refused
          ? Response.json(profile)
          : new Response(null, { status: 401 });
      }
      if (url.pathname === "/oidc/session/end") {
        if (
          url.searchParams.get("client_id") !== appId ||
          url.searchParams.get("post_logout_redirect_uri") !== registeredHomepage
        ) {
          return new Response("invalid logout request", { status: 400 });
        }
        endedSessions.push(url.searchParams.get("id_token_hint"));
        return Response.redirect(registeredHomepage, 302);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, issuer: `https://127.0.0.1:${server.port}/oidc`, approve, endedSessions };
}

/** A throwaway self-signed certificate for 127.0.0.1, written into `dir`. */
function writeCertificate(dir: string): { certFile: string; keyFile: string } {
  const certFile = join(dir, "cert.pem");
  const keyFile = join(dir, "key.pem");
  const openssl = Bun.spawnSync([
    opensslPath!,
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    keyFile,
    "-out",
    certFile,
  ]);
  if (openssl.exitCode !== 0) throw new Error(`openssl failed: ${openssl.stderr.toString()}`);
  return { certFile, keyFile };
}

test("signing in through the hosted page, from a Workspace invite link", async () => {
  // A server left on the port by an interrupted run would answer in place of this run's.
  if (
    await fetch(origin).then(
      () => true,
      () => false,
    )
  )
    throw new Error(`${origin} is already in use; stop it or set COFORGE_E2E_SIGN_IN_WEB_PORT`);

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const certDir = await mkdtemp(join(tmpdir(), "coforge-e2e-sign-in-"));
  let authing: ReturnType<typeof startFakeAuthing> | undefined;
  let web: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let webLog = "";
  const webOutput: Promise<void>[] = [];

  const session = `sign-in-flow-${process.pid}`;
  async function browser(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      env: { ...process.env, AGENT_BROWSER_IGNORE_HTTPS_ERRORS: "1" },
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
  /** Waits for a page condition, failing with the condition and the page after 20 s. */
  const waitFor = (condition: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      browser("wait", "--fn", condition).finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void browser("eval", `location.href + " | " + document.body?.innerText.slice(0, 600)`)
            .catch((error: unknown) => String(error))
            .then((page) =>
              reject(new Error(`Timed out waiting for: ${condition}\nPage: ${page}`)),
            );
        }, 20_000);
      }),
    ]);
  };
  const button = (label: string) =>
    `[...document.querySelectorAll("main button, main a")].find((element) => element.textContent.trim() === ${JSON.stringify(label)})`;
  const hydrated = (element: string) =>
    `Object.keys(${element} ?? {}).some((key) => key.startsWith("__reactProps"))`;

  const ownerId = seededUuid("e2e-sign-in-flow:owner");
  const slug = "e2e-sign-in-flow";
  const name = "Sign-in Flow Team";
  const subjects = Object.values(people).map((person) => person.sub);
  /** Removes the test accounts, the Workspaces their first sign-in made, and the invited one. */
  async function removeSeeded() {
    const identities = await db.userIdentity.findMany({
      where: { provider: "authing", providerSubject: { in: subjects } },
    });
    const userIds = [...identities.map((identity) => identity.userId), ownerId];
    // A Workspace's owner never changes, so these are the Workspaces these accounts created.
    const owned = await db.workspaceMembership.findMany({
      where: { userId: { in: userIds }, role: "owner" },
    });
    await db.workspace.deleteMany({ where: { id: { in: owned.map((row) => row.workspaceId) } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  const userIdOf = async (person: PersonKey) =>
    (
      await db.userIdentity.findUniqueOrThrow({
        where: {
          provider_providerSubject: { provider: "authing", providerSubject: people[person].sub },
        },
      })
    ).userId;

  try {
    const { certFile, keyFile } = writeCertificate(certDir);
    const fake = startFakeAuthing({
      cert: await Bun.file(certFile).text(),
      key: await Bun.file(keyFile).text(),
    });
    authing = fake;
    const onAuthingPage = `location.origin === ${JSON.stringify(new URL(fake.issuer).origin)} && !!document.querySelector("#as-alice")`;

    const server = Bun.spawn(
      [
        process.execPath,
        "--bun",
        "vite",
        "dev",
        "--port",
        String(webPort),
        "--host",
        "127.0.0.1",
        "--strictPort",
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          AUTHING_ISSUER: fake.issuer,
          AUTHING_APP_ID: appId,
          AUTHING_APP_SECRET: appSecret,
          AUTHING_REDIRECT_URI: `${origin}/auth/callback`,
          COFORGE_DEV_SKIP_AUTH: "0",
          COFORGE_SESSION_SECRET: randomBytes(32).toString("base64url"),
          NODE_EXTRA_CA_CERTS: certFile,
          COFORGE_LOG_SERVER_ERRORS: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    web = server;
    for (const stream of [server.stdout, server.stderr]) {
      webOutput.push(
        (async () => {
          const decoder = new TextDecoder();
          for await (const chunk of stream) webLog += decoder.decode(chunk, { stream: true });
        })(),
      );
    }

    // A leftover from an interrupted run starts over.
    await removeSeeded();
    await db.user.upsert({
      where: { id: ownerId },
      create: { id: ownerId, username: "e2e-sign-in-owner", displayName: "Sign-in Owner" },
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
    /** The invite page, signed in and naming the account `account` (its email, or its @username). */
    const onJoinPageAs = (account: string) =>
      `location.origin === ${JSON.stringify(origin)} && location.pathname.endsWith(${JSON.stringify(joinPath)}) && document.querySelector("main")?.innerText.includes(${JSON.stringify(`Signed in as ${account}`)})`;
    await mkdir(artifacts, { recursive: true });

    // The Web server is up once it answers; signed out, /api/me says so.
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`Web server exited:\n${webLog}`);
      const status = await fetch(`${origin}/api/me`).then(
        (response) => response.status,
        () => 0,
      );
      if (status === 401) break;
      if (Date.now() > deadline)
        throw new Error(`Web server did not start (last status ${status}):\n${webLog}`);
      await Bun.sleep(500);
    }

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
    expect(callback.headers.get("location")).toEndWith(joinPath);
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
    expect(phoneCallback.headers.get("location")).toEndWith(joinPath);
    const phoneSessionCookie = phoneCallback.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("coforge_session="))
      ?.split(";", 1)[0];
    if (!phoneSessionCookie) throw new Error("the callback set no session cookie");
    const phoneMe = await fetch(`${origin}/api/me`, { headers: { cookie: phoneSessionCookie } });
    expect(phoneMe.status).toBe(200);
    const phoneUser = ((await phoneMe.json()) as { user: Record<string, unknown> }).user;
    expect(phoneUser.email).toBeNull();
    expect(phoneUser.name).toBe(people["phone-only"].name);
    // Named by nothing they typed in: the generated username, never a phone number.
    expect(phoneUser.username).toMatch(/^user-[0-9a-f]{8}$/);

    await browser("set", "viewport", "1440", "900");

    // Signed out, the invite link offers to sign in, and signing in comes back to it to join.
    await browser("open", `${origin}/en${joinPath}`);
    await waitFor(hydrated(button("Sign in to join")));
    await browser("screenshot", join(artifacts, "1-signed-out-invite.png"));
    await browser("eval", `${button("Sign in to join")}.click()`);
    await waitFor(onAuthingPage);
    await browser("click", "#as-alice");
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
    await waitFor(onJoinPageAs(people.bob.email));

    // An account with no email is signed in, not signed out: the invite offers to join it, and
    // names the account by its @username.
    await browser("cookies", "clear");
    await browser("open", `${origin}/auth/login?returnTo=${encodeURIComponent(joinPath)}`);
    await waitFor(onAuthingPage);
    await browser("click", "#as-phone-only");
    await waitFor(onJoinPageAs(`@${String(phoneUser.username)}`));
    expect(await evaluate<boolean>(`!!${button(`Join ${name}`)}`)).toBe(true);
    expect(await evaluate<boolean>(`!!${button("Sign in to join")}`)).toBe(false);
    await browser("screenshot", join(artifacts, "6-signed-in-without-email.png"));

    // Two tabs signing in at the same time both finish: each sign-in keeps its own state.
    await browser("cookies", "clear");
    await browser("open", `${origin}/auth/login?returnTo=${encodeURIComponent(joinPath)}`);
    await waitFor(onAuthingPage);
    await browser("tab", "new");
    await browser("open", `${origin}/auth/login?returnTo=${encodeURIComponent(joinPath)}`);
    await waitFor(onAuthingPage);
    await browser("click", "#as-bob");
    await waitFor(onJoinPageAs(people.bob.email));
    await browser("tab", "0");
    await waitFor(onAuthingPage);
    await browser("click", "#as-alice");
    await waitFor(onJoinPageAs(people.alice.email));
    await browser("screenshot", join(artifacts, "7-first-tab-finished-as-alice.png"));
  } finally {
    await browser("close").catch(() => undefined);
    if (web) {
      web.kill();
      const stopped = await Promise.race([
        web.exited.then(() => true),
        Bun.sleep(10_000).then(() => false),
      ]);
      if (!stopped) web.kill("SIGKILL");
      await Promise.all(webOutput);
      await mkdir(artifacts, { recursive: true });
      await Bun.write(join(artifacts, "web.log"), webLog);
    }
    authing?.server.stop(true);
    await rm(certDir, { recursive: true, force: true });
    await removeSeeded();
    await db.$disconnect();
  }
}, 240_000);
