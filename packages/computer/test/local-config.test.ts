import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FileComputerConfig, loadBuildProfile } from "../src/local-config";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

test("current profile persists only the normalized server URL", async () => {
  const directory = await temporaryDirectory();
  const config = new FileComputerConfig(directory);

  await config.saveCurrentProfile({ serverUrl: "https://coforge.example" });

  expect(await config.loadCurrentProfile()).toEqual({ serverUrl: "https://coforge.example" });
  expect(JSON.parse(await readFile(join(directory, "profile.json"), "utf8"))).toEqual({
    server_url: "https://coforge.example",
  });
});

test("a missing profile is absent but a corrupted profile is an error", async () => {
  const directory = await temporaryDirectory();
  const config = new FileComputerConfig(directory);

  expect(await config.loadCurrentProfile()).toBeNull();
  await writeFile(join(directory, "profile.json"), "not json");
  await expect(config.loadCurrentProfile()).rejects.toBeInstanceOf(SyntaxError);
});

test("build profile loading accepts a missing profile and equivalent URL origins", async () => {
  expect(
    await loadBuildProfile(
      {
        async loadCurrentProfile() {
          return null;
        },
      },
      "https://coforge.cn",
      "setup",
    ),
  ).toBeNull();
  await expect(
    loadBuildProfile(
      {
        async loadCurrentProfile() {
          return { serverUrl: "https://coforge.cn/" };
        },
      },
      "https://coforge.cn",
      "setup",
    ),
  ).resolves.toEqual({ serverUrl: "https://coforge.cn/" });
});

test("build profile loading reports read, malformed, and environment mismatch failures stably", async () => {
  await expect(
    loadBuildProfile(
      {
        async loadCurrentProfile() {
          throw new Error("read failed");
        },
      },
      "https://coforge.cn",
      "setup",
    ),
  ).rejects.toMatchObject({ code: "SETUP_CONFIG_READ_FAILED" });
  await expect(
    loadBuildProfile(
      {
        async loadCurrentProfile() {
          return { serverUrl: "not a URL" };
        },
      },
      "https://coforge.cn",
      "setup",
    ),
  ).rejects.toMatchObject({ code: "SETUP_CONFIG_READ_FAILED" });
  await expect(
    loadBuildProfile(
      {
        async loadCurrentProfile() {
          return { serverUrl: "https://staging.coforge.cn" };
        },
      },
      "https://coforge.cn",
      "setup",
    ),
  ).rejects.toMatchObject({ code: "SETUP_BUILD_ENVIRONMENT_MISMATCH" });
});

test("each Workspace configuration persists its stable id without its slug", async () => {
  const directory = await temporaryDirectory();
  const config = new FileComputerConfig(directory);

  const configPath = await config.saveWorkspace({
    id: "workspace/id-with-path-characters",
    slug: "human-readable-slug",
  });

  expect(configPath.startsWith(join(directory, "workspaces"))).toBe(true);
  expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
    workspace_id: "workspace/id-with-path-characters",
  });
  expect(await readFile(configPath, "utf8")).not.toContain("human-readable-slug");
});

test("adding a Workspace registration preserves existing Workspace registrations", async () => {
  const directory = await temporaryDirectory();
  const config = new FileComputerConfig(directory);

  const first = await config.saveRegistration({
    id: "workspace-a",
    slug: "alpha",
    computerId: "computer-1",
  });
  const second = await config.saveRegistration({
    id: "workspace-b",
    slug: "bravo",
    computerId: "computer-1",
  });

  expect(first).not.toBe(second);
  expect(JSON.parse(await readFile(first, "utf8"))).toEqual({
    workspace_id: "workspace-a",
    workspace_slug: "alpha",
    computer_id: "computer-1",
  });
  expect(JSON.parse(await readFile(second, "utf8"))).toEqual({
    workspace_id: "workspace-b",
    workspace_slug: "bravo",
    computer_id: "computer-1",
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-computer-config-"));
  directories.push(directory);
  return directory;
}

test("registration lookup resolves either Workspace id or slug without singleton fallback", async () => {
  const config = new FileComputerConfig(await temporaryDirectory());
  await config.saveRegistration({ id: "workspace-a", slug: "alpha", computerId: "c" });
  await config.saveRegistration({ id: "workspace-b", slug: "bravo", computerId: "c" });
  expect(await config.loadRegistration("alpha")).toEqual({
    id: "workspace-a",
    slug: "alpha",
    computerId: "c",
  });
  expect(await config.loadRegistration("workspace-b")).toEqual({
    id: "workspace-b",
    slug: "bravo",
    computerId: "c",
  });
  expect(await config.loadRegistration("missing")).toBeNull();
  await expect(config.loadRegistration()).rejects.toThrow("multiple");
});
