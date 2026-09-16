import { z } from "zod";
import type { Prisma, PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";

export type GitHubConfig = {
  appId: number;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  appSlug: string;
  encryptionKey: Uint8Array<ArrayBuffer>;
  webhookSecret: string | null;
};

type Http = (url: string, init: RequestInit) => Promise<Response>;
const userSchema = z.object({
  id: z.number().int().positive().safe(),
  login: z.string().min(1).max(100),
});
const tokensSchema = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096),
  expires_in: z.number().int().positive().max(86400),
  refresh_token_expires_in: z.number().int().positive().max(31536000),
  token_type: z.literal("bearer"),
});
const credentialsSchema = tokensSchema.pick({ access_token: true, refresh_token: true });
const idSchema = z.number().int().positive().safe();
const pageSchema = z.number().int().min(1).max(10000);
const installationsSchema = z.object({
  total_count: z.number().int().nonnegative().max(300_000),
  installations: z
    .array(
      z.object({
        id: idSchema,
        app_id: idSchema,
        account: z.object({ login: z.string().min(1).max(100), type: z.string().optional() }),
        repository_selection: z.enum(["all", "selected"]),
        suspended_at: z.string().nullable().optional(),
        html_url: z
          .string()
          .url()
          .refine((value) => new URL(value).hostname === "github.com")
          .optional(),
      }),
    )
    .max(30),
});
const repositoriesSchema = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z
    .array(
      z.object({
        id: idSchema,
        full_name: z
          .string()
          .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
          .max(300),
        private: z.boolean(),
      }),
    )
    .max(30),
});
const repositorySelectionSchema = z.object({
  installationId: idSchema,
  repositoryId: idSchema,
  fullName: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .max(300),
});
const repositoryMetadataSchema = z.object({
  id: idSchema,
  full_name: z.string().min(3).max(300),
  default_branch: z.string().min(1).max(255),
});
const commitsSchema = z
  .array(
    z.object({
      sha: z.string().regex(/^[a-f0-9]{40,64}$/i),
      author: z
        .object({ login: z.string().min(1).max(100) })
        .nullable()
        .optional(),
      commit: z.object({
        message: z.string().max(100_000),
        author: z
          .object({
            name: z.string().min(1).max(500),
            date: z.string().datetime().nullable(),
          })
          .nullable(),
        committer: z
          .object({ name: z.string().min(1).max(500) })
          .nullable()
          .optional(),
      }),
    }),
  )
  .max(5);
const rootContentsSchema = z
  .array(
    z.object({
      name: z.string().min(1).max(255),
      path: z.string().min(1).max(4096),
      type: z.enum(["file", "dir", "symlink", "submodule"]),
    }),
  )
  // GitHub's Contents API returns at most 1,000 entries for a directory.
  .max(1000);

type ApiInstallation = {
  id: number;
  login: string;
  repositorySelection: "all" | "selected";
  suspended: boolean;
  configureUrl: string;
};

const REFRESH_THROTTLE_MS = 60_000;
const PROACTIVE_REFRESH_WINDOW_MS = 3_600_000;
// Module-level: configuredGitHub() builds a new GitHubConnection per request, so an
// instance field would never throttle anything.
const lastProactiveRefresh = new Map<string, number>();

/** Personal GitHub integration. Only its HTTP adapter handles bearer credentials. */
export class GitHubConnection {
  constructor(
    private readonly db: PrismaClient,
    private readonly config: GitHubConfig,
    private readonly http: Http = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async begin(userId: string, mode: "connect" | "replace" | "reauthorize" = "connect") {
    const state = randomValue();
    const verifier = randomValue();
    await this.locked(userId, async (tx) => {
      const data = {
        stateHash: hash(state),
        verifier: await this.seal(
          userId,
          "oauth",
          JSON.stringify({
            verifier,
            expectedGithubUserId:
              mode === "reauthorize"
                ? (await tx.gitHubConnection.findUnique({ where: { userId } }))?.githubUserId
                : undefined,
          }),
        ),
        expiresAt: new Date(this.now() + 600_000),
      };
      await tx.gitHubAuthorization.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
      });
    });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.callbackUrl,
      state,
      code_challenge: hash(verifier),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return { url: url.toString(), state };
  }

  beginInstallation() {
    const state = randomValue();
    const url = new URL(
      `https://github.com/apps/${this.config.appSlug}/installations/select_target`,
    );
    url.searchParams.set("state", state);
    return { url: url.toString(), state };
  }

  async complete(userId: string, browserState: string, state: string, code: string) {
    if (!state || state.length > 256 || state !== browserState || code.length > 2048) return false;
    // Commit consumption before external I/O. A later transaction abort must not
    // restore a usable verifier and permit replay of an already exchanged code.
    const verifier = await this.locked(userId, async (tx) => {
      const attempt = await tx.gitHubAuthorization.findUnique({ where: { userId } });
      if (!attempt || attempt.stateHash !== hash(state) || !attempt.verifier) return null;
      if (attempt.expiresAt.getTime() <= this.now() || !code) {
        await tx.gitHubAuthorization.delete({ where: { userId } });
        return null;
      }
      await tx.gitHubAuthorization.update({ where: { userId }, data: { verifier: "" } });
      return attempt.verifier;
    });
    if (!verifier) return false;
    const result = await this.locked(userId, async (tx) => {
      const attempt = await tx.gitHubAuthorization.findUnique({ where: { userId } });
      // A disconnect or new begin between transactions cancels finalization.
      if (!attempt || attempt.stateHash !== hash(state) || attempt.verifier) return false;
      await tx.gitHubAuthorization.delete({ where: { userId } });
      if (attempt.expiresAt.getTime() <= this.now() || !code) return false;
      // Consume failed exchanges too. Never replay a code after an ambiguous network result.
      let authorized;
      try {
        const stored = JSON.parse(await this.open(userId, "oauth", verifier)) as {
          verifier?: string;
          expectedGithubUserId?: string;
        };
        const tokens = await this.exchange({
          code,
          redirect_uri: this.config.callbackUrl,
          code_verifier: stored.verifier ?? verifier,
        });
        const user = userSchema.parse(await this.api("/user", tokens.access_token));
        authorized = { tokens, user };
      } catch {
        return false;
      }
      const { tokens, user } = authorized;
      const existing = await tx.gitHubConnection.findUnique({
        where: {
          clientId_githubUserId: { clientId: this.config.clientId, githubUserId: String(user.id) },
        },
      });
      if (existing && existing.userId !== userId) return false;
      const storedAuthorization = JSON.parse(await this.open(userId, "oauth", verifier)) as {
        expectedGithubUserId?: string;
      };
      if (
        storedAuthorization.expectedGithubUserId &&
        storedAuthorization.expectedGithubUserId !== String(user.id)
      )
        return "wrong_account" as const;
      const data = {
        clientId: this.config.clientId,
        githubUserId: String(user.id),
        login: user.login,
        ...(await this.storedTokens(userId, tokens)),
      };
      await tx.gitHubConnection.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
      });
      return true;
    });
    if (result === true) {
      try {
        // The connection is already saved. A failed sync just leaves the
        // installation cache empty until the next sync (background refresh or Refresh button).
        await this.sync(userId);
      } catch {
        // Never log GitHub response bodies, tokens, or secrets.
      }
    }
    return result;
  }

  async status(userId: string) {
    const result = await this.withToken(userId, async (token, githubUserId) => {
      const user = userSchema.parse(await this.api("/user", token));
      if (String(user.id) !== githubUserId) throw new GitHubUnauthorized();
      return user.login;
    });
    return result.ok
      ? { status: "connected" as const, login: result.data, installUrl: this.installUrl }
      : { status: result.status, login: result.login, installUrl: this.installUrl };
  }

  /** Pure DB read. No GitHub I/O, and safe to call on every Settings mount. */
  async overview(userId: string) {
    const row = await this.db.gitHubConnection.findUnique({ where: { userId } });
    if (!row) return { status: "disconnected" as const, login: null, installUrl: this.installUrl };
    if (!row.credentials)
      return { status: "reauthorize" as const, login: row.login, installUrl: this.installUrl };
    this.maybeProactivelyRefresh(userId, row);
    const rows = await this.db.gitHubUserInstallation.findMany({ where: { userId } });
    const installations = rows
      .filter((item) => !item.suspended)
      .map((item) => ({
        id: item.installationId,
        login: item.accountLogin,
        repositorySelection: item.repositorySelection as "all" | "selected",
        suspended: item.suspended,
        configureUrl: item.configureUrl,
      }));
    return installations.length === 0
      ? {
          status: "pending_installation" as const,
          login: row.login,
          installUrl: this.installUrl,
          installations: [],
        }
      : {
          status: "connected" as const,
          login: row.login,
          installUrl: this.installUrl,
          installations,
        };
  }

  /**
   * Fetches /user and /user/installations (all pages) from GitHub in parallel, verifies
   * identity, and replaces the User's installation cache in one transaction. Returns the
   * same shape as overview(). Safe to call from a background refresh or a webhook-adjacent
   * manual "Refresh" action; never called on the hot settings-load path.
   */
  async sync(userId: string) {
    const result = await this.withToken(userId, async (token, githubUserId) => {
      const [user, installations] = await Promise.all([
        this.api("/user", token).then((value) => userSchema.parse(value)),
        this.apiAllInstallations(token),
      ]);
      if (String(user.id) !== githubUserId) throw new GitHubUnauthorized();
      return installations;
    });
    if (result.ok) await this.replaceInstallations(userId, result.data);
    return this.overview(userId);
  }

  async installations(userId: string, page: number) {
    pageSchema.parse(page);
    const result = await this.withToken(userId, (token) => this.apiInstallationsPage(token, page));
    if (!result.ok) throw new AppError("ACCESS_DENIED");
    return result.data;
  }

  private async apiInstallationsPage(token: string, page: number) {
    const data = installationsSchema.parse(
      await this.api(`/user/installations?per_page=30&page=${page}`, token),
    );
    if (data.installations.some((item) => item.app_id !== this.config.appId))
      throw new AppError("ACCESS_DENIED");
    return {
      installations: data.installations.map((item): ApiInstallation => ({
        id: item.id,
        login: item.account.login,
        repositorySelection: item.repository_selection,
        suspended: Boolean(item.suspended_at),
        configureUrl: item.html_url ?? this.installUrl,
      })),
      hasMore: page * 30 < data.total_count,
    };
  }

  private async apiAllInstallations(token: string) {
    let result = await this.apiInstallationsPage(token, 1);
    const all = [...result.installations];
    let page = 2;
    while (result.hasMore && page <= 10000) {
      result = await this.apiInstallationsPage(token, page++);
      all.push(...result.installations);
    }
    return all;
  }

  private async replaceInstallations(userId: string, installations: ApiInstallation[]) {
    const syncedAt = new Date(this.now());
    const keepIds = installations.map((item) => item.id);
    await this.db.$transaction(async (tx) => {
      await tx.gitHubUserInstallation.deleteMany({
        where: { userId, installationId: { notIn: keepIds } },
      });
      for (const item of installations) {
        const data = {
          accountLogin: item.login,
          repositorySelection: item.repositorySelection,
          suspended: item.suspended,
          configureUrl: item.configureUrl,
          syncedAt,
        };
        await tx.gitHubUserInstallation.upsert({
          where: { userId_installationId: { userId, installationId: item.id } },
          create: { userId, installationId: item.id, ...data },
          update: data,
        });
      }
    });
  }

  async repositories(userId: string, installationId: number, page: number) {
    idSchema.parse(installationId);
    pageSchema.parse(page);
    const result = await this.withToken(userId, async (token) => {
      // This user-token endpoint checks BOTH personal access and App installation access.
      // Never replace it with /installation/repositories or an installation token.
      const data = repositoriesSchema.parse(
        await this.api(
          `/user/installations/${installationId}/repositories?per_page=30&page=${page}`,
          token,
        ),
      );
      return {
        repositories: data.repositories.map((item) => ({
          id: item.id,
          fullName: item.full_name,
          private: item.private,
          htmlUrl: `https://github.com/${item.full_name}`,
        })),
        hasMore: page * 30 < data.total_count,
      };
    });
    if (!result.ok) throw new AppError("ACCESS_DENIED");
    return result.data;
  }

  /**
   * Every repository the connected user can reach through a usable App installation.
   * Takes its installation list from sync(userId), so calling this also refreshes the cache.
   */
  async accessibleRepositories(userId: string) {
    const overview = await this.sync(userId);
    if (overview.status === "disconnected" || overview.status === "reauthorize")
      throw new AppError("ACCESS_DENIED");
    if (overview.status !== "connected") return [];
    const pagesPerInstallation = await Promise.all(
      overview.installations.map(async (installation) => {
        const pages = [await this.repositories(userId, installation.id, 1)];
        for (let page = 2; page <= 10000 && pages.at(-1)?.hasMore; page++)
          pages.push(await this.repositories(userId, installation.id, page));
        return pages.flatMap((page) =>
          page.repositories.map((repository) => ({
            ...repository,
            installationId: installation.id,
          })),
        );
      }),
    );
    return [
      ...new Map(
        pagesPerInstallation.flat().map((repository) => [repository.id, repository]),
      ).values(),
    ].sort((left, right) => left.fullName.localeCompare(right.fullName));
  }

  async repositoryOverview(
    userId: string,
    repository: { installationId: number; repositoryId: number; fullName: string },
  ) {
    const selected = repositorySelectionSchema.parse(repository);
    const accessible = await this.accessibleRepositories(userId);
    if (
      !accessible.some(
        (item) =>
          item.installationId === selected.installationId &&
          item.id === selected.repositoryId &&
          item.fullName === selected.fullName,
      )
    )
      throw new AppError("ACCESS_DENIED");

    const result = await this.withToken(userId, async (token) => {
      const path = `/repos/${selected.fullName}`;
      const metadata = repositoryMetadataSchema.parse(await this.api(path, token));
      if (metadata.id !== selected.repositoryId || metadata.full_name !== selected.fullName)
        throw new AppError("ACCESS_DENIED");

      const branch = encodeURIComponent(metadata.default_branch);
      const commitsResponse = await this.api(
        `${path}/commits?sha=${branch}&per_page=5`,
        token,
        true,
      );
      if (commitsResponse === null)
        return { defaultBranch: metadata.default_branch, commits: [], files: [] };

      const commits = commitsSchema.parse(commitsResponse).map((item) => ({
        sha: item.sha,
        message: item.commit.message,
        author:
          item.author?.login ??
          item.commit.author?.name ??
          item.commit.committer?.name ??
          "Unknown",
        date: item.commit.author?.date ?? null,
      }));
      const files = rootContentsSchema.parse(
        await this.api(`${path}/contents?ref=${branch}`, token),
      );
      return {
        defaultBranch: metadata.default_branch,
        commits,
        files: files.map(({ name, path: filePath, type }) => ({ name, path: filePath, type })),
      };
    });
    if (!result.ok) throw new AppError("ACCESS_DENIED");
    return result.data;
  }

  /** A current user token for one Agent-owned GitHub operation; never persisted by the caller. */
  async credential(userId: string) {
    const result = await this.withToken(userId, async (token, _githubUserId, row) => ({
      username: "x-access-token",
      password: token,
      expiresAt: row.expiresAt.toISOString(),
    }));
    if (!result.ok) throw new AppError("ACCESS_DENIED");
    return result.data;
  }

  async disconnect(userId: string) {
    await this.locked(userId, async (tx) => {
      await tx.gitHubAuthorization.deleteMany({ where: { userId } });
      await tx.gitHubConnection.deleteMany({ where: { userId } });
      await tx.gitHubUserInstallation.deleteMany({ where: { userId } });
    });
  }

  /**
   * If the cached token is close to expiry, kick off a refresh in the background without
   * blocking the (DB-only) overview() read. Throttled per userId so a burst of page loads
   * cannot fire concurrent refreshes.
   */
  private maybeProactivelyRefresh(
    userId: string,
    row: { expiresAt: Date; refreshExpiresAt: Date },
  ) {
    const now = this.now();
    if (row.expiresAt.getTime() - now >= PROACTIVE_REFRESH_WINDOW_MS) return;
    if (row.refreshExpiresAt.getTime() <= now) return;
    const last = lastProactiveRefresh.get(userId) ?? 0;
    if (now - last < REFRESH_THROTTLE_MS) return;
    lastProactiveRefresh.set(userId, now);
    void this.withToken(userId, async () => {}, PROACTIVE_REFRESH_WINDOW_MS).catch(() => {});
  }

  private async withToken<T>(
    userId: string,
    action: (
      token: string,
      githubUserId: string,
      row: { expiresAt: Date; updatedAt: Date; credentials: string | null; login: string },
    ) => Promise<T>,
    refreshWithinMs = 60_000,
  ) {
    const prepared = await this.locked(userId, async (tx) => {
      const row = await tx.gitHubConnection.findUnique({ where: { userId } });
      if (!row) return { ok: false as const, status: "disconnected" as const, login: null };
      try {
        if (!row.credentials || row.clientId !== this.config.clientId)
          throw new GitHubUnauthorized();
        let tokens = credentialsSchema.parse(
          JSON.parse(await this.open(userId, "tokens", row.credentials)),
        );
        let current = row;
        if (row.expiresAt.getTime() <= this.now() + refreshWithinMs) {
          if (row.refreshExpiresAt.getTime() <= this.now()) throw new GitHubUnauthorized();
          const refreshed = await this.exchange({
            grant_type: "refresh_token",
            refresh_token: tokens.refresh_token,
          });
          current = await tx.gitHubConnection.update({
            where: { userId },
            data: await this.storedTokens(userId, refreshed),
          });
          tokens = refreshed;
        }
        return {
          ok: true as const,
          token: tokens.access_token,
          githubUserId: row.githubUserId,
          row: current,
        };
      } catch (error) {
        if (error instanceof GitHubUnauthorized) {
          await tx.gitHubConnection.update({ where: { userId }, data: { credentials: null } });
          return { ok: false as const, status: "reauthorize" as const, login: row.login };
        }
        // Commit a rotated token even if the subsequent read fails. The action runs
        // after this transaction, so a transient GitHub failure cannot undo a refresh.
        return {
          error: error instanceof AppError ? error : new AppError("TEMPORARILY_UNAVAILABLE"),
        };
      }
    });
    if ("error" in prepared) throw prepared.error;
    if (!prepared.ok) return prepared;
    // The advisory lock only covers the token read/refresh above. GitHub reads run here,
    // outside any transaction, so a slow API call never blocks a concurrent disconnect().
    try {
      return {
        ok: true as const,
        data: await action(prepared.token, prepared.githubUserId, prepared.row),
      };
    } catch (error) {
      if (error instanceof GitHubUnauthorized) {
        await this.clearCredentialsIfUnchanged(userId, prepared.row);
        return { ok: false as const, status: "reauthorize" as const, login: prepared.row.login };
      }
      throw error instanceof AppError ? error : new AppError("TEMPORARILY_UNAVAILABLE");
    }
  }

  /** Never wipe a credential that a concurrent refresh already rotated past what we read. */
  private async clearCredentialsIfUnchanged(
    userId: string,
    seen: { updatedAt: Date; credentials: string | null },
  ) {
    await this.locked(userId, async (tx) => {
      const row = await tx.gitHubConnection.findUnique({ where: { userId } });
      if (
        !row ||
        row.updatedAt.getTime() !== seen.updatedAt.getTime() ||
        row.credentials !== seen.credentials
      )
        return;
      await tx.gitHubConnection.update({ where: { userId }, data: { credentials: null } });
    });
  }

  private get installUrl() {
    return `https://github.com/apps/${this.config.appSlug}/installations/new`;
  }

  private locked<T>(userId: string, action: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`github:${userId}`}, 0))::text`;
        return action(tx);
      },
      { timeout: 30_000, maxWait: 5_000 },
    );
  }

  private async storedTokens(userId: string, tokens: z.infer<typeof tokensSchema>) {
    return {
      credentials: await this.seal(
        userId,
        "tokens",
        JSON.stringify(credentialsSchema.parse(tokens)),
      ),
      expiresAt: new Date(this.now() + tokens.expires_in * 1000),
      refreshExpiresAt: new Date(this.now() + tokens.refresh_token_expires_in * 1000),
    };
  }

  private async exchange(fields: Record<string, string>) {
    const result = await this.request("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        ...fields,
      }).toString(),
    });
    if (
      typeof result === "object" &&
      result !== null &&
      "error" in result &&
      result.error === "bad_refresh_token"
    )
      throw new GitHubUnauthorized();
    return tokensSchema.parse(result);
  }

  private api(path: string, token: string, conflictAsNull = false) {
    return this.request(
      `https://api.github.com${path}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2026-03-10",
          "user-agent": "CoForge",
        },
      },
      conflictAsNull,
    );
  }

  private async request(url: string, init: RequestInit, conflictAsNull = false): Promise<unknown> {
    try {
      const response = await this.http(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      if (response.status === 401) throw new GitHubUnauthorized();
      if (conflictAsNull && response.status === 409) return null;
      if (
        response.status === 404 ||
        (response.status === 403 &&
          response.headers.get("x-ratelimit-remaining") !== "0" &&
          !response.headers.has("retry-after"))
      )
        throw new AppError("ACCESS_DENIED");
      if (!response.ok) throw new AppError("TEMPORARILY_UNAVAILABLE");
      return await response.json();
    } catch (error) {
      if (error instanceof GitHubUnauthorized || error instanceof AppError) throw error;
      throw new AppError("TEMPORARILY_UNAVAILABLE");
    }
  }

  private async seal(userId: string, purpose: string, value: string) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(`${this.config.clientId}:${userId}:${purpose}`),
      },
      await this.key(),
      new TextEncoder().encode(value),
    );
    return `v1.${Buffer.from(iv).toString("base64url")}.${Buffer.from(encrypted).toString("base64url")}`;
  }

  private async open(userId: string, purpose: string, value: string) {
    const [version, nonce, ciphertext, extra] = value.split(".");
    if (version !== "v1" || !nonce || !ciphertext || extra)
      throw new AppError("TEMPORARILY_UNAVAILABLE");
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Buffer.from(nonce, "base64url"),
        additionalData: new TextEncoder().encode(`${this.config.clientId}:${userId}:${purpose}`),
      },
      await this.key(),
      Buffer.from(ciphertext, "base64url"),
    );
    return new TextDecoder().decode(plaintext);
  }

  private key() {
    return crypto.subtle.importKey("raw", this.config.encryptionKey, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  }
}

class GitHubUnauthorized extends Error {}
function randomValue() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}
function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("base64url");
}
