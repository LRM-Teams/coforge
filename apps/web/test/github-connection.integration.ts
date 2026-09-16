import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { GitHubConnection } from "../src/server/integrations/github-connection.server";

if (!Bun.env.GITHUB_TEST_DATABASE_URL)
  throw new Error("GITHUB_TEST_DATABASE_URL must target disposable local PostgreSQL");
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: Bun.env.GITHUB_TEST_DATABASE_URL }),
});
afterAll(() => db.$disconnect());

const config = {
  appId: 4937758,
  clientId: "test-client",
  clientSecret: "test-secret",
  callbackUrl: "https://staging.coforge.cn/api/integrations/github/callback",
  appSlug: "coforge-staging",
  encryptionKey: new Uint8Array(32).fill(7),
};

test("authorization binds the browser and User, exchanges PKCE once, and returns no credentials", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  let exchanges = 0;
  let verifier = "";
  const connection = new GitHubConnection(db, config, async (url, init) => {
    if (url === "https://github.com/login/oauth/access_token") {
      exchanges++;
      const body = new URLSearchParams(String(init.body));
      verifier = body.get("code_verifier") ?? "";
      expect(body.get("client_secret")).toBe("test-secret");
      return Response.json({
        access_token: "ghu_test_private",
        refresh_token: "ghr_test_private",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    }
    expect(url).toBe("https://api.github.com/user");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer ghu_test_private");
    return Response.json({ id: 71, login: "test-owner" });
  });
  try {
    const attempt = await connection.begin(user.id);
    const url = new URL(attempt.url);
    const state = url.searchParams.get("state")!;
    expect(url.searchParams.get("redirect_uri")).toBe(config.callbackUrl);
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(await connection.complete(crypto.randomUUID(), state, state, "code")).toBe(false);
    expect(await connection.complete(user.id, "other-browser", state, "code")).toBe(false);
    expect(exchanges).toBe(0);
    expect(await connection.complete(user.id, state, state, "code")).toBe(true);
    expect(new Bun.CryptoHasher("sha256").update(verifier).digest("base64url")).toBe(
      url.searchParams.get("code_challenge") ?? "",
    );
    expect(await connection.complete(user.id, state, state, "code")).toBe(false);
    expect(exchanges).toBe(1);
    expect(await connection.status(user.id)).toEqual({
      status: "connected",
      login: "test-owner",
      installUrl: "https://github.com/apps/coforge-staging/installations/new",
    });
    // Persistence is inspected only to verify the security property of encryption at rest.
    const stored = await db.gitHubConnection.findUniqueOrThrow({ where: { userId: user.id } });
    expect(JSON.stringify(stored)).not.toContain("ghu_test_private");
    expect(JSON.stringify(stored)).not.toContain("ghr_test_private");
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("account replacement preserves the old connection until a new authorization succeeds", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  let failExchange = false;
  let identity = 81;
  const connection = new GitHubConnection(db, config, async (url, init) => {
    if (url.endsWith("/access_token")) {
      if (failExchange) return Response.json({}, { status: 503 });
      return Response.json({
        access_token: String(identity),
        refresh_token: "refresh",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    }
    const id = Number(new Headers(init.headers).get("authorization")?.replace("Bearer ", ""));
    return Response.json({ id, login: `account-${id}` });
  });
  try {
    const initial = await connection.begin(user.id);
    expect(await connection.complete(user.id, initial.state, initial.state, "first")).toBe(true);
    const cancelled = await connection.begin(user.id);
    expect((await connection.status(user.id)).login).toBe("account-81");
    expect(await connection.complete(user.id, cancelled.state, cancelled.state, "")).toBe(false);
    expect((await connection.status(user.id)).login).toBe("account-81");
    const failed = await connection.begin(user.id);
    failExchange = true;
    expect(await connection.complete(user.id, failed.state, failed.state, "failed")).toBe(false);
    expect((await connection.status(user.id)).login).toBe("account-81");
    failExchange = false;
    identity = 82;
    const replacement = await connection.begin(user.id);
    expect(await connection.complete(user.id, replacement.state, replacement.state, "second")).toBe(
      true,
    );
    expect((await connection.status(user.id)).login).toBe("account-82");
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("reauthorization binds the original GitHub identity while replacement may change it", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  let identity = 91;
  const connection = new GitHubConnection(db, config, async (url, init) => {
    if (url.endsWith("/access_token"))
      return Response.json({
        access_token: String(identity),
        refresh_token: "refresh",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    const id = Number(new Headers(init.headers).get("authorization")?.replace("Bearer ", ""));
    return Response.json({ id, login: `account-${id}` });
  });
  try {
    const first = await connection.begin(user.id);
    expect(await connection.complete(user.id, first.state, first.state, "code")).toBe(true);
    const retry = await connection.begin(user.id, "reauthorize");
    identity = 92;
    expect(await connection.complete(user.id, retry.state, retry.state, "code")).toBe(
      "wrong_account",
    );
    expect((await connection.status(user.id)).login).toBe("account-91");
    identity = 91;
    const same = await connection.begin(user.id, "reauthorize");
    expect(await connection.complete(user.id, same.state, same.state, "code")).toBe(true);
    identity = 92;
    const replacement = await connection.begin(user.id, "replace");
    expect(await connection.complete(user.id, replacement.state, replacement.state, "code")).toBe(
      true,
    );
    expect((await connection.status(user.id)).login).toBe("account-92");
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("overview distinguishes pending installation, suspended installs, and usable paginated installations", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  let phase = "empty";
  const installation = (id: number, suspended: boolean) => ({
    id,
    app_id: config.appId,
    account: { login: `org-${id}`, type: "Organization" },
    repository_selection: "selected",
    suspended_at: suspended ? "2026-09-14T00:00:00Z" : null,
    html_url: `https://github.com/organizations/org-${id}/settings/installations/${id}`,
  });
  const connection = new GitHubConnection(db, config, async (url) => {
    if (url.endsWith("/access_token"))
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    if (url.endsWith("/user")) return Response.json({ id: 93, login: "install-owner" });
    if (phase === "empty") return Response.json({ total_count: 0, installations: [] });
    if (phase === "failed") return Response.json({}, { status: 503 });
    const secondPage = new URL(url).searchParams.get("page") === "2";
    return Response.json({
      total_count: phase === "ready" ? 31 : 1,
      installations: secondPage ? [installation(31, false)] : [installation(1, true)],
    });
  });
  try {
    const attempt = await connection.begin(user.id);
    expect(await connection.complete(user.id, attempt.state, attempt.state, "code")).toBe(true);
    expect((await connection.overview(user.id)).status).toBe("pending_installation");
    phase = "suspended";
    expect((await connection.overview(user.id)).status).toBe("pending_installation");
    phase = "ready";
    const ready = await connection.overview(user.id);
    expect(ready.status).toBe("connected");
    if (ready.status !== "connected") throw new Error("expected connected overview");
    expect(ready.installations.map((item) => item.id)).toEqual([31]);
    expect(ready.installations[0]?.configureUrl).toBe(
      "https://github.com/organizations/org-31/settings/installations/31",
    );
    phase = "failed";
    await expect(connection.overview(user.id)).rejects.toMatchObject({
      code: "TEMPORARILY_UNAVAILABLE",
    });
    phase = "empty";
    expect((await connection.overview(user.id)).status).toBe("pending_installation");
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("authorization cannot replay after token exchange followed by a transaction abort", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  let abort = false;
  let exchanges = 0;
  const connection = new GitHubConnection(
    db,
    config,
    async (url) => {
      if (url.endsWith("/access_token")) {
        exchanges++;
        return Response.json({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 28800,
          refresh_token_expires_in: 15897600,
          token_type: "bearer",
        });
      }
      abort = true;
      return Response.json({ id: 76, login: "abort-owner" });
    },
    () => {
      if (abort) throw new Error("Injected abort while preparing credential persistence");
      return Date.now();
    },
  );
  try {
    const { state } = await connection.begin(user.id);
    await expect(connection.complete(user.id, state, state, "code")).rejects.toThrow(
      "Injected abort",
    );
    abort = false;
    expect(await connection.complete(user.id, state, state, "code")).toBe(false);
    expect(exchanges).toBe(1);
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("concurrent reads rotate an expired token once; revocation requires reauthorization", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  let now = Date.now();
  let refreshes = 0;
  let revoked = false;
  const http = async (url: string, init: RequestInit) => {
    if (url.endsWith("/access_token")) {
      const refresh = new URLSearchParams(String(init.body)).get("grant_type") === "refresh_token";
      if (refresh) refreshes++;
      return Response.json({
        access_token: refresh ? "new-access" : "old-access",
        refresh_token: "refresh",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    }
    if (revoked) return Response.json({ message: "private diagnostic" }, { status: 401 });
    expect(new Headers(init.headers).get("authorization")).toBe(
      refreshes ? "Bearer new-access" : "Bearer old-access",
    );
    return Response.json({ id: 72, login: "refresh-owner" });
  };
  const first = new GitHubConnection(db, config, http, () => now);
  const second = new GitHubConnection(db, config, http, () => now);
  try {
    const { state } = await first.begin(user.id);
    expect(await first.complete(user.id, state, state, "code")).toBe(true);
    now += 28800_000;
    const results = await Promise.all([first.status(user.id), second.status(user.id)]);
    expect(results.map((result) => result.status)).toEqual(["connected", "connected"]);
    expect(refreshes).toBe(1);
    revoked = true;
    expect((await first.status(user.id)).status).toBe("reauthorize");
    expect((await second.status(user.id)).status).toBe("reauthorize");
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("repository reads use the personal installation endpoint, paginate, and disconnect cancels pending authorization", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  const connection = new GitHubConnection(db, config, async (url) => {
    if (url.endsWith("/access_token"))
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    if (url.endsWith("/user")) return Response.json({ id: 73, login: "repository-owner" });
    if (url === "https://api.github.com/user/installations?per_page=30&page=2")
      return Response.json({
        total_count: 31,
        installations: [
          {
            id: 42,
            app_id: config.appId,
            account: { login: "example-org" },
            repository_selection: "selected",
          },
        ],
      });
    if (url === "https://api.github.com/user/installations/42/repositories?per_page=30&page=1")
      return Response.json({
        total_count: 31,
        repositories: [{ id: 99, full_name: "example-org/private-repo", private: true }],
      });
    return Response.json({}, { status: 404 });
  });
  try {
    const { state } = await connection.begin(user.id);
    expect(await connection.complete(user.id, state, state, "code")).toBe(true);
    expect(await connection.installations(user.id, 2)).toEqual({
      installations: [
        {
          id: 42,
          login: "example-org",
          repositorySelection: "selected",
          suspended: false,
          configureUrl: "https://github.com/apps/coforge-staging/installations/new",
        },
      ],
      hasMore: false,
    });
    expect(await connection.repositories(user.id, 42, 1)).toEqual({
      repositories: [
        {
          id: 99,
          fullName: "example-org/private-repo",
          private: true,
          htmlUrl: "https://github.com/example-org/private-repo",
        },
      ],
      hasMore: true,
    });
    await expect(connection.repositories(user.id, 777, 1)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    expect((await connection.status(user.id)).status).toBe("connected");
    const pending = await connection.begin(user.id);
    await connection.disconnect(user.id);
    expect(await connection.complete(user.id, pending.state, pending.state, "late-code")).toBe(
      false,
    );
    expect((await connection.status(user.id)).status).toBe("disconnected");
    await expect(connection.repositories(user.id, 42, 1)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("expired and superseded attempts fail; a transient API error preserves the rotated token", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  let now = Date.now();
  let failRead = false;
  let refreshes = 0;
  const connection = new GitHubConnection(
    db,
    config,
    async (url, init) => {
      if (url.endsWith("/access_token")) {
        if (new URLSearchParams(String(init.body)).get("grant_type") === "refresh_token")
          refreshes++;
        return Response.json({
          access_token: `access-${refreshes}`,
          refresh_token: `refresh-${refreshes}`,
          expires_in: 28800,
          refresh_token_expires_in: 15897600,
          token_type: "bearer",
        });
      }
      if (failRead) return Response.json({ message: "private error" }, { status: 503 });
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer access-${refreshes}`);
      return Response.json({ id: 74, login: "transient-owner" });
    },
    () => now,
  );
  try {
    const old = await connection.begin(user.id);
    const expiring = await connection.begin(user.id);
    expect(await connection.complete(user.id, old.state, old.state, "code")).toBe(false);
    now += 600_000;
    expect(await connection.complete(user.id, expiring.state, expiring.state, "code")).toBe(false);
    const valid = await connection.begin(user.id);
    expect(await connection.complete(user.id, valid.state, valid.state, "code")).toBe(true);
    now += 28800_000;
    failRead = true;
    await expect(connection.status(user.id)).rejects.toMatchObject({
      code: "TEMPORARILY_UNAVAILABLE",
    });
    failRead = false;
    expect((await connection.status(user.id)).status).toBe("connected");
    expect(refreshes).toBe(1);
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("disconnect waits for an in-flight refresh and no later read can resurrect credentials", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  const refreshing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let now = Date.now();
  const http = async (url: string, init: RequestInit) => {
    if (url.endsWith("/access_token")) {
      if (new URLSearchParams(String(init.body)).get("grant_type") === "refresh_token") {
        refreshing.resolve();
        await release.promise;
      }
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    }
    return Response.json({ id: 75, login: "disconnect-owner" });
  };
  const first = new GitHubConnection(db, config, http, () => now);
  const second = new GitHubConnection(db, config, http, () => now);
  const operations: Promise<unknown>[] = [];
  try {
    const { state } = await first.begin(user.id);
    expect(await first.complete(user.id, state, state, "code")).toBe(true);
    now += 28800_000;
    const reading = first.status(user.id);
    operations.push(reading);
    await refreshing.promise;
    const removing = second.disconnect(user.id);
    operations.push(removing);
    release.resolve();
    await Promise.all([reading, removing]);
    expect((await first.status(user.id)).status).toBe("disconnected");
  } finally {
    release.resolve();
    await Promise.allSettled(operations);
    await db.user.delete({ where: { id: user.id } });
  }
});
