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
/** GraphQL `avatarUrl` values are validated against the CDN host GitHub actually serves from. */
const avatarUrlSchema = z
  .string()
  .nullable()
  .transform((value) => {
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "avatars.githubusercontent.com"
        ? value
        : null;
    } catch {
      return null;
    }
  });
const graphqlErrorSchema = z.object({ type: z.string().optional() });
const graphqlIdentitySchema = z.object({ login: z.string().min(1).max(100) }).nullable();
const graphqlCommitNodeSchema = z.object({
  oid: z.string().regex(/^[a-f0-9]{40,64}$/i),
  messageHeadline: z.string().max(100_000),
  committedDate: z.string().datetime().nullable(),
  author: z
    .object({
      name: z.string().nullable(),
      avatarUrl: avatarUrlSchema,
      user: graphqlIdentitySchema,
    })
    .nullable(),
  committer: z.object({ name: z.string().nullable(), user: graphqlIdentitySchema }).nullable(),
  signature: z.object({ isValid: z.boolean() }).nullable(),
  statusCheckRollup: z.object({ state: z.string() }).nullable(),
});
const graphqlTreeEntrySchema = z.object({
  name: z.string().min(1).max(255),
  path: z.string().min(1).max(4096),
  type: z.enum(["blob", "tree", "commit"]),
  mode: z.number().int(),
});
const repositoryOverviewQuerySchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          defaultBranchRef: z
            .object({
              target: z
                .object({
                  history: z.object({ nodes: z.array(graphqlCommitNodeSchema) }).optional(),
                })
                .nullable(),
            })
            .nullable(),
          object: z.object({ entries: z.array(graphqlTreeEntrySchema).optional() }).nullable(),
        })
        .nullable(),
    })
    .nullable(),
  errors: z.array(graphqlErrorSchema).optional(),
});
const graphqlPathCommitSchema = z.object({
  oid: z.string().regex(/^[a-f0-9]{40,64}$/i),
  messageHeadline: z.string().max(100_000),
  committedDate: z.string().datetime().nullable(),
});
const pathHistoryQuerySchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          defaultBranchRef: z
            .object({
              target: z
                .record(z.string(), z.object({ nodes: z.array(graphqlPathCommitSchema) }))
                .nullable(),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullable(),
  errors: z.array(graphqlErrorSchema).optional(),
});
/**
 * `object(expression:|oid:)` on a `GitObject`. Only the `Tree`/`Blob` fragments are ever
 * requested, so a Commit/Tag target parses with neither `entries` nor `byteSize` present.
 */
const graphqlPathObjectSchema = z
  .object({
    oid: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/i)
      .optional(),
    entries: z.array(graphqlTreeEntrySchema).optional(),
    byteSize: z.number().int().nonnegative().optional(),
    isBinary: z.boolean().nullable().optional(),
    isTruncated: z.boolean().optional(),
    text: z.string().nullable().optional(),
  })
  .nullable();
const repositoryObjectQuerySchema = z.object({
  data: z
    .object({
      repository: z
        .object({ databaseId: idSchema.nullable(), object: graphqlPathObjectSchema })
        .nullable(),
    })
    .nullable(),
  errors: z.array(graphqlErrorSchema).optional(),
});
const restTreeSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string().min(1).max(4096),
      mode: z.string(),
      type: z.enum(["blob", "tree", "commit"]),
      sha: z.string().regex(/^[a-f0-9]{40,64}$/i),
    }),
  ),
});

/**
 * Rejects a GraphQL response with a top-level error and no repository data. Field-level
 * errors (e.g. `statusCheckRollup` when the App lacks Checks read) leave `data.repository`
 * populated and are tolerated — the affected field just parses as null.
 */
function assertGraphQLOk<
  T extends { data: { repository: unknown } | null; errors?: Array<{ type?: string }> },
>(response: T): T {
  if (response.errors?.length && !response.data?.repository) {
    const denied = response.errors.some(
      (error) =>
        error.type === "FORBIDDEN" ||
        error.type === "NOT_FOUND" ||
        error.type === "INSUFFICIENT_SCOPES",
    );
    throw new AppError(denied ? "ACCESS_DENIED" : "TEMPORARILY_UNAVAILABLE");
  }
  return response;
}

function mapChecksState(
  state: string | null | undefined,
): "success" | "failure" | "pending" | null {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return null;
  }
}

function mapTreeEntryType(
  entry: z.infer<typeof graphqlTreeEntrySchema>,
): "file" | "dir" | "symlink" | "submodule" {
  if (entry.type === "tree") return "dir";
  if (entry.type === "commit") return "submodule";
  return entry.mode === 40960 ? "symlink" : "file";
}

/** Maps raw Tree entries to the UI shape and sorts dirs first, then name order. */
function mapEntries(entries: Array<z.infer<typeof graphqlTreeEntrySchema>>) {
  return entries
    .map((entry) => ({ name: entry.name, path: entry.path, type: mapTreeEntryType(entry) }))
    .sort(
      (a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name),
    );
}

const REPOSITORY_OVERVIEW_QUERY = `
  query($owner: String!, $name: String!, $expression: String!) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(first: 5) {
              nodes {
                oid
                messageHeadline
                committedDate
                author { name avatarUrl(size: 80) user { login } }
                committer { name user { login } }
                signature { isValid }
                statusCheckRollup { state }
              }
            }
          }
        }
      }
      object(expression: $expression) {
        ... on Tree { entries { name type path mode } }
      }
    }
  }
`;

/** Builds a `history(first: 1, path: $pN)` alias per path, chunked by the caller. */
function buildPathHistoryQuery(count: number): string {
  const variableDeclarations = Array.from(
    { length: count },
    (_, index) => `$p${index}: String!`,
  ).join(", ");
  const aliasFields = Array.from(
    { length: count },
    (_, index) =>
      `p${index}: history(first: 1, path: $p${index}) { nodes { oid messageHeadline committedDate } }`,
  ).join("\n");
  return `
    query($owner: String!, $name: String!, ${variableDeclarations}) {
      repository(owner: $owner, name: $name) {
        defaultBranchRef {
          target {
            ... on Commit {
              ${aliasFields}
            }
          }
        }
      }
    }
  `;
}

const MAX_PATH_LENGTH = 4096;
const MAX_BLOB_PREVIEW_BYTES = 1_048_576;

/**
 * Rejects absolute paths, `.`/`..` segments, empty segments, and control characters
 * before any GitHub read. `""` is the repository root and is always valid.
 */
function validateRepositoryPath(path: string): string {
  if (typeof path !== "string" || path.length > MAX_PATH_LENGTH) throw new AppError("NOT_FOUND");
  // eslint-disable-next-line no-control-regex -- deliberately rejecting control characters, including NUL.
  if (/[\x00-\x1f\x7f]/.test(path)) throw new AppError("NOT_FOUND");
  if (path === "") return path;
  if (path.startsWith("/")) throw new AppError("NOT_FOUND");
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
    throw new AppError("NOT_FOUND");
  return path;
}

/**
 * One request per file click: the repository's `databaseId` rides along so the identity
 * check needs no separate REST call. Exactly one of `$expression` / `$oid` is non-null.
 */
const REPOSITORY_OBJECT_QUERY = `
  query($owner: String!, $name: String!, $expression: String, $oid: GitObjectID) {
    repository(owner: $owner, name: $name) {
      databaseId
      object(expression: $expression, oid: $oid) {
        oid
        ... on Tree { entries { name type path mode } }
        ... on Blob { byteSize isBinary isTruncated text }
      }
    }
  }
`;

type ApiInstallation = {
  id: number;
  login: string;
  repositorySelection: "all" | "selected";
  suspended: boolean;
  configureUrl: string;
};

const REFRESH_THROTTLE_MS = 60_000;
const PROACTIVE_REFRESH_WINDOW_MS = 3_600_000;
// Compute a last-touching commit for at most this many root entries (dirs first, then name
// order — the same order the UI shows), chunked into GraphQL requests of this size.
const MAX_LAST_COMMIT_PATHS = 100;
const MAX_PATHS_PER_QUERY = 50;
// Module-level: configuredGitHub() builds a new GitHubConnection per request, so an
// instance field would never throttle anything.
const lastProactiveRefresh = new Map<string, number>();
// Recursive trees keyed by repository id and revalidated with `If-None-Match` on every read.
// GitHub answers 304 only to a token that may read the repository, so a cached body is
// never served to a User GitHub would refuse. Module-level for the same reason as above.
const MAX_CACHED_TREES = 50;
type RepositoryTree = {
  sha: string;
  truncated: boolean;
  entries: Array<{ path: string; type: "file" | "dir" | "symlink" | "submodule"; sha: string }>;
};
const repositoryTrees = new Map<
  number,
  { etag: string; defaultBranch: string; tree: RepositoryTree }
>();

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
    return this.withVerifiedRepository(
      userId,
      repository,
      async (token, { owner, name, defaultBranch }) => {
        const overview = assertGraphQLOk(
          repositoryOverviewQuerySchema.parse(
            await this.graphql(
              REPOSITORY_OVERVIEW_QUERY,
              { owner, name, expression: `${defaultBranch}:` },
              token,
            ),
          ),
        );
        const branchRef = overview.data?.repository?.defaultBranchRef;
        if (!branchRef) return { defaultBranch, commits: [], files: [] };

        const commits = (branchRef.target?.history?.nodes ?? []).map((node) => {
          const authorLogin = node.author?.user?.login;
          const author = authorLogin ?? node.author?.name ?? "Unknown";
          const committerLogin = node.committer?.user?.login;
          const committerDisplay = committerLogin ?? node.committer?.name ?? null;
          return {
            sha: node.oid,
            message: node.messageHeadline,
            author,
            authorAvatarUrl: node.author?.avatarUrl ?? null,
            committer: committerDisplay && committerDisplay !== author ? committerDisplay : null,
            date: node.committedDate ?? null,
            verified: node.signature?.isValid ?? false,
            checks: mapChecksState(node.statusCheckRollup?.state),
          };
        });

        const entries = mapEntries(overview.data?.repository?.object?.entries ?? []);
        const withCommits = entries.slice(0, MAX_LAST_COMMIT_PATHS);
        const withoutCommits = entries.slice(MAX_LAST_COMMIT_PATHS);
        const lastCommits = await this.lastCommitsForPaths(
          owner,
          name,
          withCommits.map((entry) => entry.path),
          token,
        );
        const files = [
          ...withCommits.map((entry, index) => ({
            ...entry,
            lastCommit: lastCommits[index] ?? null,
          })),
          ...withoutCommits.map((entry) => ({ ...entry, lastCommit: null })),
        ];

        return { defaultBranch, commits, files };
      },
    );
  }

  /**
   * The whole default-branch tree in one REST request (`recursive=1`), revalidated with
   * `If-None-Match` so an unchanged branch costs a 304 that GitHub does not count against
   * the rate limit. `truncated` is GitHub's own flag (over 100,000 entries or 7 MB); the
   * caller then falls back to `repositoryObject()` per directory.
   */
  async repositoryTree(
    userId: string,
    repository: { installationId: number; repositoryId: number; fullName: string },
  ) {
    return this.withRepository(userId, repository, async (token, selected) => {
      const metadata = repositoryMetadataSchema.parse(
        await this.api(`/repos/${selected.fullName}`, token),
      );
      if (metadata.id !== selected.repositoryId || metadata.full_name !== selected.fullName)
        throw new AppError("ACCESS_DENIED");
      const defaultBranch = metadata.default_branch;
      const cached = repositoryTrees.get(selected.repositoryId);
      const reusable = cached?.defaultBranch === defaultBranch ? cached : undefined;
      const response = await this.send(
        `https://api.github.com/repos/${selected.fullName}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
        {
          headers: {
            ...this.restHeaders(token),
            ...(reusable ? { "if-none-match": reusable.etag } : {}),
          },
        },
        reusable ? [304] : [],
      );
      if (response.status === 304 && reusable) return { defaultBranch, ...reusable.tree };
      const parsed = restTreeSchema.parse(await response.json());
      const tree: RepositoryTree = {
        sha: parsed.sha,
        truncated: parsed.truncated,
        entries: parsed.tree.map((entry) => ({
          path: entry.path,
          type:
            entry.type === "tree"
              ? "dir"
              : entry.type === "commit"
                ? "submodule"
                : entry.mode === "120000"
                  ? "symlink"
                  : "file",
          sha: entry.sha,
        })),
      };
      const etag = response.headers.get("etag");
      if (etag) {
        repositoryTrees.delete(selected.repositoryId);
        repositoryTrees.set(selected.repositoryId, { etag, defaultBranch, tree });
        if (repositoryTrees.size > MAX_CACHED_TREES)
          repositoryTrees.delete(repositoryTrees.keys().next().value as number);
      }
      return { defaultBranch, ...tree };
    });
  }

  /**
   * One Tree or Blob in a single GraphQL request. `oid` (from `repositoryTree()`) addresses
   * immutable content; without it the path resolves against `HEAD`. The response's
   * `databaseId` is the identity check, so a renamed-and-replaced repository is refused
   * without a second call. Access is GitHub's: a user access token only reaches what both
   * the User and the App installation can read.
   */
  async repositoryObject(
    userId: string,
    repository: { installationId: number; repositoryId: number; fullName: string },
    target: { path: string; oid?: string },
  ) {
    const validPath = validateRepositoryPath(target.path);
    return this.withRepository(userId, repository, async (token, selected) => {
      const [owner, name] = selected.fullName.split("/");
      const response = assertGraphQLOk(
        repositoryObjectQuerySchema.parse(
          await this.graphql(
            REPOSITORY_OBJECT_QUERY,
            target.oid
              ? { owner, name, oid: target.oid, expression: null }
              : { owner, name, oid: null, expression: `HEAD:${validPath}` },
            token,
          ),
        ),
      );
      const repo = response.data?.repository;
      if (repo && repo.databaseId !== selected.repositoryId) throw new AppError("ACCESS_DENIED");
      const object = repo?.object;
      if (!object) throw new AppError("NOT_FOUND");
      if (object.entries !== undefined)
        return { kind: "tree" as const, path: validPath, entries: mapEntries(object.entries) };
      if (object.byteSize === undefined) throw new AppError("NOT_FOUND");
      const reason: "binary" | "truncated" | "too_large" | undefined = object.isBinary
        ? "binary"
        : object.isTruncated
          ? "truncated"
          : object.byteSize > MAX_BLOB_PREVIEW_BYTES
            ? "too_large"
            : undefined;
      return {
        kind: "blob" as const,
        path: validPath,
        name: validPath.split("/").pop() || validPath,
        oid: object.oid ?? null,
        byteSize: object.byteSize,
        text: reason ? null : (object.text ?? null),
        ...(reason ? { reason } : {}),
      };
    });
  }

  /**
   * The last commit touching each entry of one directory, keyed by entry path. Loaded after
   * the listing is already on screen, so its extra history request never delays navigation.
   */
  async repositoryDirectoryCommits(
    userId: string,
    repository: { installationId: number; repositoryId: number; fullName: string },
    path: string,
  ) {
    const directory = await this.repositoryObject(userId, repository, { path });
    if (directory.kind !== "tree") throw new AppError("NOT_FOUND");
    const paths = directory.entries.slice(0, MAX_LAST_COMMIT_PATHS).map((entry) => entry.path);
    const result = await this.withToken(userId, (token) => {
      const [owner, name] = repository.fullName.split("/");
      return this.lastCommitsForPaths(owner, name, paths, token);
    });
    if (!result.ok) throw new AppError("ACCESS_DENIED");
    return Object.fromEntries(paths.map((entryPath, index) => [entryPath, result.data[index]]));
  }

  /** The file's bytes, streamed for Download/Raw. Up to GitHub's 100 MB contents limit. */
  async repositoryRaw(
    userId: string,
    repository: { installationId: number; repositoryId: number; fullName: string },
    path: string,
  ) {
    const validPath = validateRepositoryPath(path);
    if (validPath === "") throw new AppError("NOT_FOUND");
    return this.withRepository(userId, repository, async (token, selected) => {
      const metadata = repositoryMetadataSchema.parse(
        await this.api(`/repos/${selected.fullName}`, token),
      );
      if (metadata.id !== selected.repositoryId || metadata.full_name !== selected.fullName)
        throw new AppError("ACCESS_DENIED");
      const encodedPath = validPath.split("/").map(encodeURIComponent).join("/");
      return this.send(
        `https://api.github.com/repos/${selected.fullName}/contents/${encodedPath}`,
        { headers: { ...this.restHeaders(token), accept: "application/vnd.github.raw+json" } },
        [],
        // The signal also bounds reading the body, and a download streams well past 8 s.
        120_000,
      );
    });
  }

  /**
   * Hot read path for browsing: a current user token and nothing else. Unlike
   * `withVerifiedRepository()` it does not enumerate the User's installations — GitHub
   * already limits a user access token to repositories both the User and the App
   * installation can read — so each caller checks repository identity in its own request.
   */
  private async withRepository<T>(
    userId: string,
    repository: { installationId: number; repositoryId: number; fullName: string },
    action: (token: string, selected: z.infer<typeof repositorySelectionSchema>) => Promise<T>,
  ): Promise<T> {
    const selected = repositorySelectionSchema.parse(repository);
    const result = await this.withToken(userId, (token) => action(token, selected));
    if (!result.ok) throw new AppError("ACCESS_DENIED");
    return result.data;
  }

  /**
   * Access check + REST metadata identity check used by `repositoryOverview()`: verifies the selected repository is still reachable through an
   * installation this user can use, then confirms GitHub's REST metadata still matches
   * the selected id/full name. `action` runs with the verified user token.
   */
  private async withVerifiedRepository<T>(
    userId: string,
    repository: { installationId: number; repositoryId: number; fullName: string },
    action: (
      token: string,
      repo: { owner: string; name: string; defaultBranch: string },
    ) => Promise<T>,
  ): Promise<T> {
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
      const [owner, name] = selected.fullName.split("/");
      return action(token, { owner, name, defaultBranch: metadata.default_branch });
    });
    if (!result.ok) throw new AppError("ACCESS_DENIED");
    return result.data;
  }

  /** At most one GraphQL request per `MAX_PATHS_PER_QUERY` paths; each aliased history costs 1 point. */
  private async lastCommitsForPaths(owner: string, name: string, paths: string[], token: string) {
    const results: Array<{ sha: string; message: string; date: string } | null> = [];
    for (let offset = 0; offset < paths.length; offset += MAX_PATHS_PER_QUERY) {
      const chunk = paths.slice(offset, offset + MAX_PATHS_PER_QUERY);
      const variables: Record<string, string> = { owner, name };
      chunk.forEach((value, index) => {
        variables[`p${index}`] = value;
      });
      const response = assertGraphQLOk(
        pathHistoryQuerySchema.parse(
          await this.graphql(buildPathHistoryQuery(chunk.length), variables, token),
        ),
      );
      const target = response.data?.repository?.defaultBranchRef?.target;
      chunk.forEach((_, index) => {
        const node = target?.[`p${index}`]?.nodes.at(0);
        results.push(
          node
            ? { sha: node.oid, message: node.messageHeadline, date: node.committedDate ?? "" }
            : null,
        );
      });
    }
    return results;
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

  private restHeaders(token: string) {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2026-03-10",
      "user-agent": "CoForge",
    };
  }

  private api(path: string, token: string) {
    return this.request(`https://api.github.com${path}`, { headers: this.restHeaders(token) });
  }

  /** Every GraphQL caller goes through `request()`, so 401/403/404/timeout semantics stay identical. */
  private graphql(query: string, variables: Record<string, unknown>, token: string) {
    return this.request("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": "CoForge",
      },
      body: JSON.stringify({ query, variables }),
    });
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    try {
      return await (await this.send(url, init)).json();
    } catch (error) {
      if (error instanceof GitHubUnauthorized || error instanceof AppError) throw error;
      throw new AppError("TEMPORARILY_UNAVAILABLE");
    }
  }

  /** `request()` without the JSON read, for conditional (304) and streamed responses. */
  private async send(url: string, init: RequestInit, alsoAccept: number[] = [], timeoutMs = 8000) {
    try {
      const response = await this.http(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 401) throw new GitHubUnauthorized();
      if (
        response.status === 404 ||
        (response.status === 403 &&
          response.headers.get("x-ratelimit-remaining") !== "0" &&
          !response.headers.has("retry-after"))
      )
        throw new AppError("ACCESS_DENIED");
      if (!response.ok && !alsoAccept.includes(response.status))
        throw new AppError("TEMPORARILY_UNAVAILABLE");
      return response;
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
