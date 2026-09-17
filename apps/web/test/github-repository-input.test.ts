import { expect, test } from "bun:test";
import { AppError } from "../src/lib/app-error";
import { parseGitHubRepositoryInput } from "../src/features/projects/github-repository-input";
import { GitHubConnection } from "../src/server/integrations/github-connection.server";

test("reads owner/repo, github.com URLs, and SSH remotes", () => {
  expect(parseGitHubRepositoryInput("acme/widgets")).toEqual({ fullName: "acme/widgets" });
  expect(parseGitHubRepositoryInput("https://github.com/acme/widgets")).toEqual({
    fullName: "acme/widgets",
  });
  expect(parseGitHubRepositoryInput("https://www.github.com/acme/widgets.git")).toEqual({
    fullName: "acme/widgets",
  });
  expect(parseGitHubRepositoryInput("https://github.com/acme/widgets/tree/main")).toEqual({
    fullName: "acme/widgets",
  });
  expect(parseGitHubRepositoryInput("git@github.com:acme/widgets.git")).toEqual({
    fullName: "acme/widgets",
  });
});

test("rejects empty input and non-GitHub hosts", () => {
  expect(parseGitHubRepositoryInput("")).toBeNull();
  expect(parseGitHubRepositoryInput("https://gitlab.com/acme/widgets")).toBeNull();
  expect(parseGitHubRepositoryInput("not a repository")).toBeNull();
});

const publicConfig = {
  appId: 4937758,
  clientId: "test-client",
  clientSecret: "test-secret",
  callbackUrl: "https://staging.coforge.cn/api/integrations/github/callback",
  appSlug: "coforge-staging",
  encryptionKey: new Uint8Array(32).fill(7),
  webhookSecret: null,
};

test("public GitHub lookup stores only public github.com repositories", async () => {
  const requested: string[] = [];
  const connection = new GitHubConnection({} as never, publicConfig, async (url) => {
    requested.push(url);
    expect(new URL(url).pathname).toBe("/repos/acme/widgets");
    return Response.json({
      id: 42,
      full_name: "acme/widgets",
      private: false,
      html_url: "https://github.com/acme/widgets",
    });
  });
  await expect(connection.lookupPublicRepository("acme/widgets")).resolves.toEqual({
    id: 42,
    fullName: "acme/widgets",
    htmlUrl: "https://github.com/acme/widgets",
  });
  expect(requested).toEqual(["https://api.github.com/repos/acme/widgets"]);
});

test("public GitHub lookup rejects private repositories and missing names", async () => {
  const connection = new GitHubConnection({} as never, publicConfig, async () =>
    Response.json({
      id: 9,
      full_name: "acme/secret",
      private: true,
      html_url: "https://github.com/acme/secret",
    }),
  );
  await expect(connection.lookupPublicRepository("acme/secret")).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  expect(() => connection.lookupPublicRepository("https://gitlab.com/acme/widgets")).toThrow();
});

test("missing public GitHub repositories are denied like private ones", async () => {
  const connection = new GitHubConnection(
    {} as never,
    publicConfig,
    async () => new Response("{}", { status: 404 }),
  );
  await expect(connection.lookupPublicRepository("missing/repo")).rejects.toBeInstanceOf(AppError);
  await expect(connection.lookupPublicRepository("missing/repo")).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
});
