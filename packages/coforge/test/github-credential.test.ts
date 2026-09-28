import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGitHubCli, runGitHubCredentialHelper } from "#src/github-credential";

test("gets the current user credential for a valid HTTPS GitHub path", async () => {
  let lookups = 0;
  const output = await runGitHubCredentialHelper(
    "get",
    "protocol=https\nhost=github.com\npath=Example-Org/private-repo.git\n\n",
    async () => {
      lookups++;
      return {
        username: "x-access-token",
        password: "short-lived-token",
        expiresAt: "2026-09-16T21:00:00Z",
      };
    },
  );

  expect(lookups).toBe(1);
  expect(output).toBe("username=x-access-token\npassword=short-lived-token\n\n");
});

test("does not answer credentials for another host or protocol", async () => {
  let calls = 0;
  const lookup = async () => {
    calls++;
    throw new Error("must not request a credential");
  };

  expect(
    await runGitHubCredentialHelper(
      "get",
      "protocol=https\nhost=gitlab.com\npath=org/repo\n\n",
      lookup,
    ),
  ).toBe("");
  expect(
    await runGitHubCredentialHelper(
      "get",
      "protocol=ssh\nhost=github.com\npath=org/repo\n\n",
      lookup,
    ),
  ).toBe("");
  expect(calls).toBe(0);
});

test("rejects an unscoped GitHub credential request", async () => {
  await expect(
    runGitHubCredentialHelper(
      "get",
      "protocol=https\nhost=github.com\npath=private-repo\n\n",
      async () => {
        throw new Error("must not request a credential");
      },
    ),
  ).rejects.toThrow("GitHub credential repository is invalid");
});

test("does not persist or erase short-lived credentials", async () => {
  const lookup = async () => {
    throw new Error("must not request a credential");
  };
  expect(await runGitHubCredentialHelper("store", "password=secret\n\n", lookup)).toBe("");
  expect(await runGitHubCredentialHelper("erase", "password=secret\n\n", lookup)).toBe("");
});

test("runs the real GitHub CLI with a fresh token without recursing into the wrapper", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-gh-"));
  const wrapperDirectory = join(root, "wrapper");
  const hostDirectory = join(root, "host");
  const output = join(root, "output");
  await Bun.write(join(wrapperDirectory, "gh"), "#!/bin/sh\nexit 99\n");
  await Bun.write(
    join(hostDirectory, "gh"),
    '#!/bin/sh\nprintf "%s\\n" "$GH_TOKEN" "$@" > "$GH_TEST_OUTPUT"\n',
  );
  await Promise.all([
    chmod(join(wrapperDirectory, "gh"), 0o700),
    chmod(join(hostDirectory, "gh"), 0o700),
  ]);

  const environment = {
    PATH: `${wrapperDirectory}:${hostDirectory}`,
    GH_TEST_OUTPUT: output,
  };
  expect(
    await runGitHubCli(
      ["pr", "view", "17"],
      async () => ({
        username: "x-access-token",
        password: "short-lived-token",
        expiresAt: "2026-09-16T21:00:00Z",
      }),
      environment,
      join(wrapperDirectory, "coforge-computer"),
    ),
  ).toBe(0);
  expect(await readFile(output, "utf8")).toBe("short-lived-token\npr\nview\n17\n");
  expect(environment).not.toHaveProperty("GH_TOKEN");
});

test("does not request a token when the host GitHub CLI is unavailable", async () => {
  let lookups = 0;
  await expect(
    runGitHubCli(
      ["repo", "view"],
      async () => {
        lookups++;
        throw new Error("must not request a credential");
      },
      { PATH: "" },
      "/coforge/coforge-computer",
    ),
  ).rejects.toThrow("GitHub CLI is not installed");
  expect(lookups).toBe(0);
});
