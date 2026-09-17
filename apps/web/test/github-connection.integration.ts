import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { GitHubConnection } from "../src/server/integrations/github-connection.server";
import { applyGitHubWebhookEvent } from "../src/server/integrations/github-webhook.server";

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
  webhookSecret: null,
};

test("authorization binds the browser and issues the Agent owner's current user token", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  const now = Date.parse("2026-09-16T20:00:00Z");
  let exchanges = 0;
  let verifier = "";
  const connection = new GitHubConnection(
    db,
    config,
    async (url, init) => {
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
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer ghu_test_private");
      if (url.startsWith("https://api.github.com/user/installations"))
        return Response.json({ total_count: 0, installations: [] });
      expect(url).toBe("https://api.github.com/user");
      return Response.json({ id: 71, login: "test-owner" });
    },
    () => now,
  );
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
    const installation = connection.beginInstallation();
    expect(new URL(installation.url).pathname).toBe(
      "/apps/coforge-staging/installations/select_target",
    );
    expect(new URL(installation.url).searchParams.get("state")).toBe(installation.state);
    const credential = await connection.credential(user.id);
    expect(credential.username).toBe("x-access-token");
    expect(credential.password).toBe(["ghu", "test", "private"].join("_"));
    expect(credential.expiresAt).toBe("2026-09-17T04:00:00.000Z");
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

test("sync() drives pending installation, suspended installs, and usable paginated installations; overview() reflects each sync from the database", async () => {
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
    // complete() already ran one sync() while phase is still "empty".
    expect(await connection.complete(user.id, attempt.state, attempt.state, "code")).toBe(true);
    expect((await connection.overview(user.id)).status).toBe("pending_installation");

    phase = "suspended";
    expect((await connection.sync(user.id)).status).toBe("pending_installation");
    expect((await connection.overview(user.id)).status).toBe("pending_installation");

    phase = "ready";
    const ready = await connection.sync(user.id);
    expect(ready.status).toBe("connected");
    if (ready.status !== "connected") throw new Error("expected connected overview");
    expect(ready.installations.map((item) => item.id)).toEqual([31]);
    expect(ready.installations[0]?.configureUrl).toBe(
      "https://github.com/organizations/org-31/settings/installations/31",
    );
    // overview() is a pure DB read: it reflects what the last sync() wrote, unchanged
    // by the live phase below, until something calls sync() again.
    expect(await connection.overview(user.id)).toEqual(ready);

    phase = "failed";
    await expect(connection.sync(user.id)).rejects.toMatchObject({
      code: "TEMPORARILY_UNAVAILABLE",
    });
    // A failed sync() leaves the previously cached rows in place.
    expect(await connection.overview(user.id)).toEqual(ready);

    phase = "empty";
    expect((await connection.sync(user.id)).status).toBe("pending_installation");
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

function graphqlBody(init: RequestInit): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
}
const isOverviewQuery = (init: RequestInit) => graphqlBody(init).query.includes("history(first: 5");

test("repository overview verifies the selected installation and maps GitHub repository data via GraphQL", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  const requested: string[] = [];
  const connection = new GitHubConnection(db, config, async (url, init) => {
    requested.push(url);
    expect(new Headers(init.headers).get("authorization") ?? "").not.toContain("installation");
    if (url.endsWith("/access_token"))
      return Response.json({
        access_token: "user-access",
        refresh_token: "refresh",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    if (url.endsWith("/user")) return Response.json({ id: 101, login: "overview-owner" });
    if (url === "https://api.github.com/user/installations?per_page=30&page=1")
      return Response.json({
        total_count: 1,
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
        total_count: 1,
        repositories: [{ id: 99, full_name: "example-org/private-repo", private: true }],
      });
    if (url === "https://api.github.com/repos/example-org/private-repo")
      return Response.json({
        id: 99,
        full_name: "example-org/private-repo",
        default_branch: "trunk",
      });
    if (url === "https://api.github.com/graphql") {
      expect(new Headers(init.headers).get("content-type")).toBe("application/json");
      expect(new Headers(init.headers).get("accept")).toBe("application/json");
      expect(new Headers(init.headers).has("x-github-api-version")).toBe(false);
      const body = graphqlBody(init);
      if (isOverviewQuery(init)) {
        expect(body.variables).toEqual({
          owner: "example-org",
          name: "private-repo",
          expression: "trunk:",
        });
        return Response.json({
          data: {
            repository: {
              defaultBranchRef: {
                target: {
                  history: {
                    nodes: [
                      {
                        oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        messageHeadline: "Ship asymmetric fixture",
                        committedDate: "2026-09-15T08:30:00Z",
                        author: {
                          name: "Author Name",
                          avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
                          user: { login: "linked-login" },
                        },
                        committer: { name: "Committer Name", user: { login: "committer-login" } },
                        signature: { isValid: true },
                        statusCheckRollup: { state: "SUCCESS" },
                      },
                      {
                        oid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                        messageHeadline: "Unlinked author",
                        committedDate: null,
                        author: {
                          name: "Offline Author",
                          // A non-CDN host must never be trusted as an avatar URL.
                          avatarUrl: "https://evil.example.com/avatar.png",
                          user: null,
                        },
                        committer: null,
                        signature: null,
                        statusCheckRollup: null,
                      },
                    ],
                  },
                },
              },
              object: {
                entries: [
                  { name: "src", type: "tree", path: "src", mode: 16384 },
                  { name: "README.md", type: "blob", path: "README.md", mode: 33188 },
                  { name: "current", type: "blob", path: "current", mode: 40960 },
                  { name: "vendor", type: "commit", path: "vendor", mode: 160000 },
                ],
              },
            },
          },
        });
      }
      // Entries sort dirs first, then name order: src, current, README.md, vendor.
      expect(body.variables).toEqual({
        owner: "example-org",
        name: "private-repo",
        p0: "src",
        p1: "current",
        p2: "README.md",
        p3: "vendor",
      });
      return Response.json({
        data: {
          repository: {
            defaultBranchRef: {
              target: {
                p0: {
                  nodes: [
                    {
                      oid: "cccccccccccccccccccccccccccccccccccccccc",
                      messageHeadline: "Refactor src layout",
                      committedDate: "2026-09-14T00:00:00Z",
                    },
                  ],
                },
                p1: {
                  nodes: [
                    {
                      oid: "dddddddddddddddddddddddddddddddddddddddd",
                      messageHeadline: "Point symlink at latest",
                      committedDate: "2026-09-13T00:00:00Z",
                    },
                  ],
                },
                p2: {
                  nodes: [
                    {
                      oid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                      messageHeadline: "Update README",
                      committedDate: "2026-09-12T00:00:00Z",
                    },
                  ],
                },
                p3: { nodes: [] },
              },
            },
          },
        },
      });
    }
    return Response.json({}, { status: 404 });
  });
  try {
    const { state } = await connection.begin(user.id);
    expect(await connection.complete(user.id, state, state, "code")).toBe(true);
    expect(
      await connection.repositoryOverview(user.id, {
        installationId: 42,
        repositoryId: 99,
        fullName: "example-org/private-repo",
      }),
    ).toEqual({
      defaultBranch: "trunk",
      commits: [
        {
          sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          message: "Ship asymmetric fixture",
          author: "linked-login",
          authorAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
          committer: "committer-login",
          date: "2026-09-15T08:30:00Z",
          verified: true,
          checks: "success",
        },
        {
          sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          message: "Unlinked author",
          author: "Offline Author",
          authorAvatarUrl: null,
          committer: null,
          date: null,
          verified: false,
          checks: null,
        },
      ],
      files: [
        {
          name: "src",
          path: "src",
          type: "dir",
          lastCommit: {
            sha: "cccccccccccccccccccccccccccccccccccccccc",
            message: "Refactor src layout",
            date: "2026-09-14T00:00:00Z",
          },
        },
        {
          name: "current",
          path: "current",
          type: "symlink",
          lastCommit: {
            sha: "dddddddddddddddddddddddddddddddddddddddd",
            message: "Point symlink at latest",
            date: "2026-09-13T00:00:00Z",
          },
        },
        {
          name: "README.md",
          path: "README.md",
          type: "file",
          lastCommit: {
            sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            message: "Update README",
            date: "2026-09-12T00:00:00Z",
          },
        },
        { name: "vendor", path: "vendor", type: "submodule", lastCommit: null },
      ],
    });
    expect(requested.filter((url) => url === "https://api.github.com/graphql")).toHaveLength(2);
    expect(requested).not.toContain(
      "https://api.github.com/repos/example-org/private-repo/commits?sha=trunk&per_page=5",
    );
    expect(requested).not.toContain(
      "https://api.github.com/repos/example-org/private-repo/contents?ref=trunk",
    );
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("repository overview denies identity mismatches and treats a null default branch ref as empty", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  let metadataId = 100;
  let graphqlReads = 0;
  const connection = new GitHubConnection(db, config, async (url) => {
    if (url.endsWith("/access_token"))
      return Response.json({
        access_token: "user-access",
        refresh_token: "refresh",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    if (url.endsWith("/user")) return Response.json({ id: 102, login: "empty-owner" });
    if (url.includes("/user/installations/42/repositories"))
      return Response.json({
        total_count: 1,
        repositories: [{ id: 99, full_name: "example-org/empty", private: true }],
      });
    if (url.includes("/user/installations"))
      return Response.json({
        total_count: 1,
        installations: [
          {
            id: 42,
            app_id: config.appId,
            account: { login: "example-org" },
            repository_selection: "selected",
          },
        ],
      });
    if (url === "https://api.github.com/repos/example-org/empty")
      return Response.json({
        id: metadataId,
        full_name: "example-org/empty",
        default_branch: "main",
      });
    graphqlReads++;
    return Response.json({ data: { repository: { defaultBranchRef: null, object: null } } });
  });
  const selected = { installationId: 42, repositoryId: 99, fullName: "example-org/empty" };
  try {
    const { state } = await connection.begin(user.id);
    expect(await connection.complete(user.id, state, state, "code")).toBe(true);
    await expect(
      connection.repositoryOverview(user.id, { ...selected, installationId: 43 }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(graphqlReads).toBe(0);
    await expect(connection.repositoryOverview(user.id, selected)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    expect(graphqlReads).toBe(0);

    metadataId = 99;
    expect(await connection.repositoryOverview(user.id, selected)).toEqual({
      defaultBranch: "main",
      commits: [],
      files: [],
    });
    expect(graphqlReads).toBe(1);
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("repository overview chunks per-path history requests and leaves entries beyond the cap without a last commit", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  const ENTRY_COUNT = 120;
  const entries = Array.from({ length: ENTRY_COUNT }, (_, index) => ({
    name: `file${String(index).padStart(3, "0")}`,
    type: "blob" as const,
    path: `file${String(index).padStart(3, "0")}`,
    mode: 33188,
  }));
  let perPathRequests = 0;
  const connection = new GitHubConnection(db, config, async (url, init) => {
    if (url.endsWith("/access_token"))
      return Response.json({
        access_token: "user-access",
        refresh_token: "refresh",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    if (url.endsWith("/user")) return Response.json({ id: 104, login: "chunking-owner" });
    if (url.includes("/user/installations/42/repositories"))
      return Response.json({
        total_count: 1,
        repositories: [{ id: 99, full_name: "example-org/wide", private: true }],
      });
    if (url.includes("/user/installations"))
      return Response.json({
        total_count: 1,
        installations: [
          {
            id: 42,
            app_id: config.appId,
            account: { login: "example-org" },
            repository_selection: "selected",
          },
        ],
      });
    if (url === "https://api.github.com/repos/example-org/wide")
      return Response.json({ id: 99, full_name: "example-org/wide", default_branch: "main" });
    if (url === "https://api.github.com/graphql") {
      if (isOverviewQuery(init))
        return Response.json({
          data: {
            repository: {
              defaultBranchRef: { target: { history: { nodes: [] } } },
              object: { entries },
            },
          },
        });
      perPathRequests++;
      const variables = graphqlBody(init).variables as Record<string, string>;
      const target: Record<string, { nodes: unknown[] }> = {};
      for (const [alias, path] of Object.entries(variables).filter(([key]) =>
        key.startsWith("p"),
      )) {
        const index = Number(path.replace("file", ""));
        target[alias] = {
          nodes: [
            {
              oid: index.toString(16).padStart(40, "0"),
              messageHeadline: `Touch file${index}`,
              committedDate: "2026-01-01T00:00:00Z",
            },
          ],
        };
      }
      return Response.json({ data: { repository: { defaultBranchRef: { target } } } });
    }
    return Response.json({}, { status: 404 });
  });
  try {
    const { state } = await connection.begin(user.id);
    expect(await connection.complete(user.id, state, state, "code")).toBe(true);
    const overview = await connection.repositoryOverview(user.id, {
      installationId: 42,
      repositoryId: 99,
      fullName: "example-org/wide",
    });
    expect(overview.files).toHaveLength(ENTRY_COUNT);
    overview.files.slice(0, 100).forEach((file, index) => {
      expect(file.lastCommit).toEqual({
        sha: index.toString(16).padStart(40, "0"),
        message: `Touch file${index}`,
        date: "2026-01-01T00:00:00Z",
      });
    });
    overview.files.slice(100).forEach((file) => {
      expect(file.lastCommit).toBeNull();
    });
    // 100 capped paths chunked at 50 per request.
    expect(perPathRequests).toBe(2);
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("repository overview denies a forbidden top-level GraphQL error but tolerates a field-level error", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  let forbidden = true;
  const connection = new GitHubConnection(db, config, async (url) => {
    if (url.endsWith("/access_token"))
      return Response.json({
        access_token: "user-access",
        refresh_token: "refresh",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    if (url.endsWith("/user")) return Response.json({ id: 105, login: "forbidden-owner" });
    if (url.includes("/user/installations/42/repositories"))
      return Response.json({
        total_count: 1,
        repositories: [{ id: 99, full_name: "example-org/forbidden", private: true }],
      });
    if (url.includes("/user/installations"))
      return Response.json({
        total_count: 1,
        installations: [
          {
            id: 42,
            app_id: config.appId,
            account: { login: "example-org" },
            repository_selection: "selected",
          },
        ],
      });
    if (url === "https://api.github.com/repos/example-org/forbidden")
      return Response.json({ id: 99, full_name: "example-org/forbidden", default_branch: "main" });
    if (url === "https://api.github.com/graphql") {
      if (forbidden)
        return Response.json({
          data: { repository: null },
          errors: [{ type: "FORBIDDEN", message: "private diagnostic" }],
        });
      return Response.json({
        data: {
          repository: {
            defaultBranchRef: {
              target: {
                history: {
                  nodes: [
                    {
                      oid: "ffffffffffffffffffffffffffffffffffffffff",
                      messageHeadline: "Tolerate field error",
                      committedDate: "2026-02-01T00:00:00Z",
                      author: { name: "Someone", avatarUrl: null, user: { login: "someone" } },
                      committer: null,
                      signature: null,
                      statusCheckRollup: null,
                    },
                  ],
                },
              },
            },
            object: { entries: [] },
          },
        },
        // Field-level error (e.g. the App lacks Checks read): data.repository is still present.
        errors: [{ type: "FORBIDDEN", message: "Resource not accessible: statusCheckRollup" }],
      });
    }
    return Response.json({}, { status: 404 });
  });
  const selected = { installationId: 42, repositoryId: 99, fullName: "example-org/forbidden" };
  try {
    const { state } = await connection.begin(user.id);
    expect(await connection.complete(user.id, state, state, "code")).toBe(true);
    await expect(connection.repositoryOverview(user.id, selected)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    forbidden = false;
    expect(await connection.repositoryOverview(user.id, selected)).toEqual({
      defaultBranch: "main",
      commits: [
        {
          sha: "ffffffffffffffffffffffffffffffffffffffff",
          message: "Tolerate field error",
          author: "someone",
          authorAvatarUrl: null,
          committer: null,
          date: "2026-02-01T00:00:00Z",
          verified: false,
          checks: null,
        },
      ],
      files: [],
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

test("a slow GitHub read does not block a concurrent disconnect (only token refresh holds the advisory lock)", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let slow = false;
  const http = async (url: string) => {
    if (url.endsWith("/access_token"))
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    if (!slow) return Response.json({ id: 78, login: "slow-owner" });
    reading.resolve();
    await release.promise;
    return Response.json({ id: 78, login: "slow-owner" });
  };
  const first = new GitHubConnection(db, config, http);
  const second = new GitHubConnection(db, config, http);
  const operations: Promise<unknown>[] = [];
  try {
    const { state } = await first.begin(user.id);
    // complete()'s own background sync() runs here with `slow` still false.
    expect(await first.complete(user.id, state, state, "code")).toBe(true);
    slow = true;
    const slowStatus = first.status(user.id);
    operations.push(slowStatus);
    await reading.promise;
    // Today (before this change) the GitHub read ran inside the advisory-lock
    // transaction, so this disconnect would hang until `release` resolves below. It
    // must not: the lock now only covers the token read/refresh, not the action.
    await second.disconnect(user.id);
    expect((await second.status(user.id)).status).toBe("disconnected");
    release.resolve();
    await slowStatus;
  } finally {
    release.resolve();
    await Promise.allSettled(operations);
    await db.user.delete({ where: { id: user.id } });
  }
});

test("overview() reads only the database and reflects rows written by sync()", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  const installationPayload = (suspended: boolean) => ({
    id: 501,
    app_id: config.appId,
    account: { login: "cache-org" },
    repository_selection: "selected",
    suspended_at: suspended ? "2026-09-16T00:00:00Z" : null,
    html_url: "https://github.com/organizations/cache-org/settings/installations/501",
  });
  let installationsResponse = () => ({
    total_count: 1,
    installations: [installationPayload(false)],
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
    if (url.endsWith("/user")) return Response.json({ id: 501, login: "cache-owner" });
    return Response.json(installationsResponse());
  });
  const throwingConnection = new GitHubConnection(db, config, async () => {
    throw new Error("overview() must never make an HTTP call");
  });
  try {
    const { state } = await connection.begin(user.id);
    expect(await connection.complete(user.id, state, state, "code")).toBe(true);
    // complete() already ran sync() once with the payload above.
    expect(await throwingConnection.overview(user.id)).toEqual({
      status: "connected",
      login: "cache-owner",
      installUrl: "https://github.com/apps/coforge-staging/installations/new",
      installations: [
        {
          id: 501,
          login: "cache-org",
          repositorySelection: "selected",
          suspended: false,
          configureUrl: "https://github.com/organizations/cache-org/settings/installations/501",
        },
      ],
    });

    installationsResponse = () => ({ total_count: 1, installations: [installationPayload(true)] });
    await connection.sync(user.id);
    expect(await throwingConnection.overview(user.id)).toEqual({
      status: "pending_installation",
      login: "cache-owner",
      installUrl: "https://github.com/apps/coforge-staging/installations/new",
      installations: [],
    });

    installationsResponse = () => ({ total_count: 0, installations: [] });
    await connection.sync(user.id);
    expect(await throwingConnection.overview(user.id)).toEqual({
      status: "pending_installation",
      login: "cache-owner",
      installUrl: "https://github.com/apps/coforge-staging/installations/new",
      installations: [],
    });
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("sync() fetches /user and /user/installations concurrently, paginates, drops suspended installations, and deletes stale rows", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  const installation = (id: number, suspended: boolean) => ({
    id,
    app_id: config.appId,
    account: { login: `org-${id}` },
    repository_selection: "selected" as const,
    suspended_at: suspended ? "2026-09-16T00:00:00Z" : null,
    html_url: `https://github.com/organizations/org-${id}/settings/installations/${id}`,
  });
  let gateEnabled = false;
  let userStarted = false;
  let installationsStarted = false;
  let bothStarted = Promise.withResolvers<void>();
  let page = (_n: number): { total_count: number; installations: unknown[] } => ({
    total_count: 0,
    installations: [],
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
    if (url.endsWith("/user")) {
      if (gateEnabled) {
        userStarted = true;
        if (installationsStarted) bothStarted.resolve();
        await bothStarted.promise;
      }
      return Response.json({ id: 701, login: "paginated-owner" });
    }
    const pageNumber = Number(new URL(url).searchParams.get("page") ?? "1");
    if (gateEnabled && pageNumber === 1) {
      installationsStarted = true;
      if (userStarted) bothStarted.resolve();
      await bothStarted.promise;
    }
    return Response.json(page(pageNumber));
  });
  try {
    const { state } = await connection.begin(user.id);
    expect(await connection.complete(user.id, state, state, "code")).toBe(true);

    // Proves /user and /user/installations run concurrently: if sync() awaited them
    // serially, the /user call below would never see installationsStarted flip and
    // this test would time out instead of completing.
    gateEnabled = true;
    page = (n) =>
      n === 1
        ? { total_count: 31, installations: [installation(1, true)] }
        : { total_count: 31, installations: [installation(31, false)] };
    const mixed = await connection.sync(user.id);
    expect(mixed.status).toBe("connected");
    if (mixed.status !== "connected") throw new Error("expected connected overview");
    expect(mixed.installations.map((item) => item.id)).toEqual([31]);
    expect(await db.gitHubUserInstallation.count({ where: { userId: user.id } })).toBe(2);

    gateEnabled = false;
    page = () => ({ total_count: 1, installations: [installation(1, true)] });
    await connection.sync(user.id);
    expect((await connection.overview(user.id)).status).toBe("pending_installation");
    expect(await db.gitHubUserInstallation.count({ where: { userId: user.id } })).toBe(1);

    page = () => ({ total_count: 1, installations: [installation(31, false)] });
    const resynced = await connection.sync(user.id);
    expect(resynced.status).toBe("connected");
    if (resynced.status !== "connected") throw new Error("expected connected overview");
    expect(resynced.installations.map((item) => item.id)).toEqual([31]);
    const rows = await db.gitHubUserInstallation.findMany({ where: { userId: user.id } });
    expect(rows.map((row) => row.installationId)).toEqual([31]);
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("webhook events keep the installation cache in sync without calling GitHub", async () => {
  const userA = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  const userB = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  const throwingConnection = new GitHubConnection(db, config, async () => {
    throw new Error("webhook processing must not call GitHub");
  });
  try {
    await db.gitHubConnection.create({
      data: {
        userId: userA.id,
        clientId: config.clientId,
        githubUserId: "9001",
        login: "webhook-owner-a",
        credentials: "v1.opaque.opaque",
        expiresAt: new Date(Date.now() + 8 * 3_600_000),
        refreshExpiresAt: new Date(Date.now() + 180 * 86_400_000),
      },
    });
    await db.gitHubConnection.create({
      data: {
        userId: userB.id,
        clientId: config.clientId,
        githubUserId: "9002",
        login: "webhook-owner-b",
        credentials: "v1.opaque.opaque",
        expiresAt: new Date(Date.now() + 8 * 3_600_000),
        refreshExpiresAt: new Date(Date.now() + 180 * 86_400_000),
      },
    });
    await db.gitHubUserInstallation.create({
      data: {
        userId: userA.id,
        installationId: 4200,
        accountLogin: "webhook-org",
        repositorySelection: "all",
        suspended: false,
        configureUrl: "https://github.com/organizations/webhook-org/settings/installations/4200",
        syncedAt: new Date(),
      },
    });

    // A mismatched app_id is ignored entirely.
    await applyGitHubWebhookEvent(db, config, "installation", {
      action: "suspend",
      installation: {
        id: 4200,
        app_id: config.appId + 1,
        account: { login: "webhook-org" },
        repository_selection: "all",
      },
    });
    expect((await throwingConnection.overview(userA.id)).status).toBe("connected");

    // suspend / unsuspend toggle the cached row.
    await applyGitHubWebhookEvent(db, config, "installation", {
      action: "suspend",
      installation: {
        id: 4200,
        app_id: config.appId,
        account: { login: "webhook-org" },
        repository_selection: "all",
      },
    });
    expect((await throwingConnection.overview(userA.id)).status).toBe("pending_installation");
    await applyGitHubWebhookEvent(db, config, "installation", {
      action: "unsuspend",
      installation: {
        id: 4200,
        app_id: config.appId,
        account: { login: "webhook-org" },
        repository_selection: "all",
      },
    });
    expect((await throwingConnection.overview(userA.id)).status).toBe("connected");

    // installation_repositories updates the cached selection.
    await applyGitHubWebhookEvent(db, config, "installation_repositories", {
      action: "removed",
      installation: {
        id: 4200,
        app_id: config.appId,
        account: { login: "webhook-org" },
        repository_selection: "selected",
      },
    });
    expect(
      (
        await db.gitHubUserInstallation.findUniqueOrThrow({
          where: { userId_installationId: { userId: userA.id, installationId: 4200 } },
        })
      ).repositorySelection,
    ).toBe("selected");

    // "created" by a connected sender (userB) inserts a row for that user immediately.
    await applyGitHubWebhookEvent(db, config, "installation", {
      action: "created",
      installation: {
        id: 4200,
        app_id: config.appId,
        account: { login: "webhook-org" },
        repository_selection: "all",
        html_url: "https://github.com/organizations/webhook-org/settings/installations/4200",
      },
      sender: { id: 9002 },
    });
    const overviewB = await throwingConnection.overview(userB.id);
    expect(overviewB.status).toBe("connected");
    if (overviewB.status !== "connected") throw new Error("expected connected overview");
    expect(overviewB.installations.map((item) => item.id)).toEqual([4200]);

    // github_app_authorization "revoked" clears credentials and installation rows.
    await applyGitHubWebhookEvent(db, config, "github_app_authorization", {
      action: "revoked",
      sender: { id: 9001 },
    });
    expect((await throwingConnection.overview(userA.id)).status).toBe("reauthorize");
    expect(await db.gitHubUserInstallation.count({ where: { userId: userA.id } })).toBe(0);

    // "deleted" removes the installation's rows across every user who had them.
    await applyGitHubWebhookEvent(db, config, "installation", {
      action: "deleted",
      installation: {
        id: 4200,
        app_id: config.appId,
        account: { login: "webhook-org" },
        repository_selection: "all",
      },
    });
    expect(await db.gitHubUserInstallation.count({ where: { installationId: 4200 } })).toBe(0);
  } finally {
    await db.gitHubUserInstallation.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
    await db.gitHubConnection.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
    await db.user.delete({ where: { id: userA.id } });
    await db.user.delete({ where: { id: userB.id } });
  }
});

test("overview() rotates a token expiring within the hour in the background, once per minute per user", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  let now = 1_800_000_000_000;
  let refreshes = 0;
  const http = async (url: string, init: RequestInit) => {
    if (url.endsWith("/access_token")) {
      if (new URLSearchParams(String(init.body)).get("grant_type") === "refresh_token") refreshes++;
      return Response.json({
        access_token: `access-${refreshes}`,
        refresh_token: `refresh-${refreshes}`,
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    }
    if (url.endsWith("/user")) return Response.json({ id: 75, login: "expiring-owner" });
    return Response.json({ total_count: 0, installations: [] });
  };
  const connection = new GitHubConnection(db, config, http, () => now);
  try {
    const { state } = await connection.begin(user.id);
    expect(await connection.complete(user.id, state, state, "code")).toBe(true);
    // 7.5h in: still 30 minutes of validity, so a fresh page load must not block on GitHub.
    now += 27_000_000;
    // A new instance per request, as configuredGitHub() does in production.
    const first = await new GitHubConnection(db, config, http, () => now).overview(user.id);
    expect(first.status).toBe("pending_installation");
    await Bun.sleep(50);
    expect(refreshes).toBe(1);
    await new GitHubConnection(db, config, http, () => now).overview(user.id);
    await Bun.sleep(50);
    expect(refreshes).toBe(1);
    const stored = await db.gitHubConnection.findUniqueOrThrow({ where: { userId: user.id } });
    expect(stored.expiresAt.getTime()).toBe(now + 28_800_000);
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

const isRepositoryPathQuery = (init: RequestInit) =>
  graphqlBody(init).variables.target !== undefined;

test("repositoryPath rejects invalid paths before touching GitHub or the database", async () => {
  const connection = new GitHubConnection(db, config, async () => {
    throw new Error("repositoryPath must not call GitHub for an invalid path");
  });
  const selected = { installationId: 42, repositoryId: 99, fullName: "example-org/invalid-paths" };
  const invalidPaths = ["../x", "/x", "a//b", "a/./b", "a/..", "..", "a/b/", "a b"];
  for (const path of invalidPaths) {
    await expect(
      connection.repositoryPath(crypto.randomUUID(), selected, path),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }
});

test("repositoryPath returns a Tree node with per-entry last commits and the ancestor chain for the side tree", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  const connection = new GitHubConnection(db, config, async (url, init) => {
    if (url.endsWith("/access_token"))
      return Response.json({
        access_token: "user-access",
        refresh_token: "refresh",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    if (url.endsWith("/user")) return Response.json({ id: 201, login: "tree-owner" });
    if (url.includes("/user/installations/42/repositories"))
      return Response.json({
        total_count: 1,
        repositories: [{ id: 99, full_name: "example-org/tree-repo", private: true }],
      });
    if (url.includes("/user/installations"))
      return Response.json({
        total_count: 1,
        installations: [
          {
            id: 42,
            app_id: config.appId,
            account: { login: "example-org" },
            repository_selection: "selected",
          },
        ],
      });
    if (url === "https://api.github.com/repos/example-org/tree-repo")
      return Response.json({ id: 99, full_name: "example-org/tree-repo", default_branch: "main" });
    if (url === "https://api.github.com/graphql") {
      const body = graphqlBody(init);
      if (isRepositoryPathQuery(init)) {
        expect(body.variables).toEqual({
          owner: "example-org",
          name: "tree-repo",
          target: "main:docs/adr",
          a0: "main:",
          a1: "main:docs",
        });
        return Response.json({
          data: {
            repository: {
              target: {
                entries: [
                  {
                    name: "0001-example.md",
                    type: "blob",
                    path: "docs/adr/0001-example.md",
                    mode: 33188,
                  },
                ],
              },
              a0: {
                entries: [
                  { name: "docs", type: "tree", path: "docs", mode: 16384 },
                  { name: "README.md", type: "blob", path: "README.md", mode: 33188 },
                ],
              },
              a1: {
                entries: [
                  { name: "adr", type: "tree", path: "docs/adr", mode: 16384 },
                  { name: "design.md", type: "blob", path: "docs/design.md", mode: 33188 },
                ],
              },
            },
          },
        });
      }
      // Per-path last-commit lookup on the Tree target's own entries.
      expect(body.variables).toEqual({
        owner: "example-org",
        name: "tree-repo",
        p0: "docs/adr/0001-example.md",
      });
      return Response.json({
        data: {
          repository: {
            defaultBranchRef: {
              target: {
                p0: {
                  nodes: [
                    {
                      oid: "1111111111111111111111111111111111111111",
                      messageHeadline: "Add ADR 0001",
                      committedDate: "2026-01-01T00:00:00Z",
                    },
                  ],
                },
              },
            },
          },
        },
      });
    }
    return Response.json({}, { status: 404 });
  });
  const selected = { installationId: 42, repositoryId: 99, fullName: "example-org/tree-repo" };
  try {
    const { state } = await connection.begin(user.id);
    expect(await connection.complete(user.id, state, state, "code")).toBe(true);
    expect(await connection.repositoryPath(user.id, selected, "docs/adr")).toEqual({
      defaultBranch: "main",
      path: "docs/adr",
      ancestors: [
        {
          path: "",
          entries: [
            { name: "docs", path: "docs", type: "dir" },
            { name: "README.md", path: "README.md", type: "file" },
          ],
        },
        {
          path: "docs",
          entries: [
            { name: "adr", path: "docs/adr", type: "dir" },
            { name: "design.md", path: "docs/design.md", type: "file" },
          ],
        },
      ],
      node: {
        kind: "tree",
        entries: [
          {
            name: "0001-example.md",
            path: "docs/adr/0001-example.md",
            type: "file",
            lastCommit: {
              sha: "1111111111111111111111111111111111111111",
              message: "Add ADR 0001",
              date: "2026-01-01T00:00:00Z",
            },
          },
        ],
      },
    });
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("repositoryPath returns Blob text for a small text file", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  const connection = new GitHubConnection(db, config, async (url, init) => {
    if (url.endsWith("/access_token"))
      return Response.json({
        access_token: "user-access",
        refresh_token: "refresh",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    if (url.endsWith("/user")) return Response.json({ id: 202, login: "blob-text-owner" });
    if (url.includes("/user/installations/42/repositories"))
      return Response.json({
        total_count: 1,
        repositories: [{ id: 99, full_name: "example-org/blob-repo", private: true }],
      });
    if (url.includes("/user/installations"))
      return Response.json({
        total_count: 1,
        installations: [
          {
            id: 42,
            app_id: config.appId,
            account: { login: "example-org" },
            repository_selection: "selected",
          },
        ],
      });
    if (url === "https://api.github.com/repos/example-org/blob-repo")
      return Response.json({ id: 99, full_name: "example-org/blob-repo", default_branch: "main" });
    if (url === "https://api.github.com/graphql") {
      const body = graphqlBody(init);
      expect(body.variables).toEqual({
        owner: "example-org",
        name: "blob-repo",
        target: "main:docs/design.md",
        a0: "main:",
        a1: "main:docs",
      });
      return Response.json({
        data: {
          repository: {
            target: {
              byteSize: 27,
              isBinary: false,
              isTruncated: false,
              text: "# CoForge design guidance",
            },
            a0: { entries: [{ name: "docs", type: "tree", path: "docs", mode: 16384 }] },
            a1: {
              entries: [{ name: "design.md", type: "blob", path: "docs/design.md", mode: 33188 }],
            },
          },
        },
      });
    }
    return Response.json({}, { status: 404 });
  });
  const selected = { installationId: 42, repositoryId: 99, fullName: "example-org/blob-repo" };
  try {
    const { state } = await connection.begin(user.id);
    expect(await connection.complete(user.id, state, state, "code")).toBe(true);
    expect(await connection.repositoryPath(user.id, selected, "docs/design.md")).toEqual({
      defaultBranch: "main",
      path: "docs/design.md",
      ancestors: [
        { path: "", entries: [{ name: "docs", path: "docs", type: "dir" }] },
        { path: "docs", entries: [{ name: "design.md", path: "docs/design.md", type: "file" }] },
      ],
      node: { kind: "blob", name: "design.md", byteSize: 27, text: "# CoForge design guidance" },
    });
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("repositoryPath marks binary, truncated, and oversized blobs unpreviewable with the right reason", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  let blob: { byteSize: number; isBinary: boolean; isTruncated: boolean; text: string | null } = {
    byteSize: 10,
    isBinary: true,
    isTruncated: false,
    text: null,
  };
  const connection = new GitHubConnection(db, config, async (url) => {
    if (url.endsWith("/access_token"))
      return Response.json({
        access_token: "user-access",
        refresh_token: "refresh",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    if (url.endsWith("/user")) return Response.json({ id: 203, login: "blob-variant-owner" });
    if (url.includes("/user/installations/42/repositories"))
      return Response.json({
        total_count: 1,
        repositories: [{ id: 99, full_name: "example-org/blob-variants", private: true }],
      });
    if (url.includes("/user/installations"))
      return Response.json({
        total_count: 1,
        installations: [
          {
            id: 42,
            app_id: config.appId,
            account: { login: "example-org" },
            repository_selection: "selected",
          },
        ],
      });
    if (url === "https://api.github.com/repos/example-org/blob-variants")
      return Response.json({
        id: 99,
        full_name: "example-org/blob-variants",
        default_branch: "main",
      });
    if (url === "https://api.github.com/graphql")
      return Response.json({ data: { repository: { target: blob, a0: { entries: [] } } } });
    return Response.json({}, { status: 404 });
  });
  const selected = { installationId: 42, repositoryId: 99, fullName: "example-org/blob-variants" };
  try {
    const { state } = await connection.begin(user.id);
    expect(await connection.complete(user.id, state, state, "code")).toBe(true);

    expect((await connection.repositoryPath(user.id, selected, "image.png")).node).toEqual({
      kind: "blob",
      name: "image.png",
      byteSize: 10,
      text: null,
      reason: "binary",
    });

    blob = { byteSize: 20, isBinary: false, isTruncated: true, text: "partial" };
    expect((await connection.repositoryPath(user.id, selected, "huge.log")).node).toEqual({
      kind: "blob",
      name: "huge.log",
      byteSize: 20,
      text: null,
      reason: "truncated",
    });

    blob = { byteSize: 1_048_577, isBinary: false, isTruncated: false, text: "x".repeat(10) };
    expect((await connection.repositoryPath(user.id, selected, "large.txt")).node).toEqual({
      kind: "blob",
      name: "large.txt",
      byteSize: 1_048_577,
      text: null,
      reason: "too_large",
    });
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});

test("repositoryPath treats a null object as NOT_FOUND", async () => {
  const user = await db.user.create({ data: { username: `github-${crypto.randomUUID()}` } });
  const connection = new GitHubConnection(db, config, async (url, init) => {
    if (url.endsWith("/access_token"))
      return Response.json({
        access_token: "user-access",
        refresh_token: "refresh",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    if (url.endsWith("/user")) return Response.json({ id: 204, login: "null-object-owner" });
    if (url.includes("/user/installations/42/repositories"))
      return Response.json({
        total_count: 1,
        repositories: [{ id: 99, full_name: "example-org/missing-paths", private: true }],
      });
    if (url.includes("/user/installations"))
      return Response.json({
        total_count: 1,
        installations: [
          {
            id: 42,
            app_id: config.appId,
            account: { login: "example-org" },
            repository_selection: "selected",
          },
        ],
      });
    if (url === "https://api.github.com/repos/example-org/missing-paths")
      return Response.json({
        id: 99,
        full_name: "example-org/missing-paths",
        default_branch: "main",
      });
    if (url === "https://api.github.com/graphql") {
      const body = graphqlBody(init);
      expect(body.variables.target).toBe("main:missing.txt");
      return Response.json({ data: { repository: { target: null, a0: { entries: [] } } } });
    }
    return Response.json({}, { status: 404 });
  });
  const selected = { installationId: 42, repositoryId: 99, fullName: "example-org/missing-paths" };
  try {
    const { state } = await connection.begin(user.id);
    expect(await connection.complete(user.id, state, state, "code")).toBe(true);
    await expect(connection.repositoryPath(user.id, selected, "missing.txt")).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});
