import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readComputerUpgradeReceipt } from "@lrm/coforge-daemon";

import { buildReleaseTree } from "../../../scripts/release/build-release";
import {
  CONTRACT_DIRECTORY,
  EXAMPLE_REQUEST_ID,
  renderInstallerContract,
} from "../scripts/installer-contract";
import { InstallerReceiptSchema, INSTALLER_EXIT_CODE } from "#src/release/installer-contract";
import { launchHoldContents } from "#src/release/upgrade-lifecycle";
import {
  ActiveStateSchema,
  ComputerUpdater,
  InstalledIdentitySchema,
  ReleaseManifestSchema,
} from "#src/updater";

const RUST_OUTPUT = join(CONTRACT_DIRECTORY, "rust");

async function committedFiles(): Promise<string[]> {
  const entries = await readdir(CONTRACT_DIRECTORY, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "coforge-installer-contract-"));
}

test("the committed installer contract is exactly what the generator renders", async () => {
  const rendered = renderInstallerContract();
  expect(await committedFiles()).toEqual([...rendered.keys()].sort());
  for (const [name, contents] of rendered) {
    expect(await readFile(join(CONTRACT_DIRECTORY, name), "utf8")).toBe(contents);
  }
});

test("the release build writes a manifest the contract schema accepts", async () => {
  const directory = await scratch();
  try {
    await buildReleaseTree(
      {
        version: "0.2.0",
        commit: "0123456789abcdef0123456789abcdef01234567",
        buildDate: "2026-09-29T00:00:00.000Z",
        artifacts: { "linux-x64": { computer: new TextEncoder().encode("computer") } },
        photonWasm: new TextEncoder().encode("wasm"),
      },
      directory,
    );
    const manifest = JSON.parse(await readFile(join(directory, "0.2.0", "manifest.json"), "utf8"));
    expect(ReleaseManifestSchema.parse(manifest).version).toBe("0.2.0");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the updater reads the active.json the installer writes", async () => {
  const text = await readFile(join(RUST_OUTPUT, "active.v1.json"), "utf8");
  expect(ActiveStateSchema.parse(JSON.parse(text))).toEqual({
    schema_version: 1,
    current: "0.2.0",
    previous: "0.1.0",
  });
  const installRoot = await scratch();
  try {
    await copyFile(join(RUST_OUTPUT, "active.v1.json"), join(installRoot, "active.json"));
    const updater = new ComputerUpdater({
      baseUrl: "https://releases.example.invalid/",
      target: "linux-x64",
      installRoot,
    });
    expect(await updater.getCurrentVersion()).toBe("0.2.0");
  } finally {
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("the installation.json the installer writes is a current installed identity", async () => {
  const identity = InstalledIdentitySchema.parse(
    JSON.parse(await readFile(join(RUST_OUTPUT, "installation.v4.json"), "utf8")),
  );
  expect(identity.schema_version).toBe(4);
});

test("the Daemon reads every receipt the installer writes", async () => {
  const expectations = {
    "receipt.succeeded.json": {
      status: "succeeded",
      version: "0.2.0",
      errorCode: undefined,
      exit: INSTALLER_EXIT_CODE.SUCCEEDED,
    },
    "receipt.rolled-back.json": {
      status: "failed",
      version: undefined,
      errorCode: "UPGRADE_ROLLED_BACK",
      exit: INSTALLER_EXIT_CODE.FAILED,
    },
    "receipt.unresolved.json": {
      status: "failed",
      version: undefined,
      errorCode: "UPGRADE_ROLLBACK_FAILED",
      exit: INSTALLER_EXIT_CODE.UNRESOLVED,
    },
  } as const;
  for (const [name, expected] of Object.entries(expectations)) {
    const receipt = InstallerReceiptSchema.parse(
      JSON.parse(await readFile(join(RUST_OUTPUT, name), "utf8")),
    );
    expect(receipt.exit_code).toBe(expected.exit);
    const homeDirectory = await scratch();
    try {
      const results = join(homeDirectory, ".coforge", "computer", "install", "upgrade-results");
      await mkdir(results, { recursive: true });
      await copyFile(join(RUST_OUTPUT, name), join(results, `${EXAMPLE_REQUEST_ID}.result.json`));
      const read = await readComputerUpgradeReceipt(EXAMPLE_REQUEST_ID, { homeDirectory });
      expect(read?.status).toBe(expected.status);
      expect(read?.version).toBe(expected.version);
      expect(read?.errorCode).toBe(expected.errorCode);
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  }
});

test("the installer's launch-hold names the request the Coordinator reads", async () => {
  const text = await readFile(join(RUST_OUTPUT, "launch-hold.txt"), "utf8");
  expect(text).toBe(launchHoldContents(EXAMPLE_REQUEST_ID));
});
