import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FileComputerConfig } from "../src/local-config";

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

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-computer-config-"));
  directories.push(directory);
  return directory;
}
