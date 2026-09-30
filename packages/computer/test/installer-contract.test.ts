import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readComputerUpgradeReceipt } from "@lrm/coforge-daemon";
import { z } from "zod";

import { buildReleaseTree } from "../../../scripts/release/build-release";
import {
  CONTRACT_DIRECTORY,
  EXAMPLE_REQUEST_ID,
  renderInstallerContract,
} from "../scripts/installer-contract";
import { InstallerReceiptSchema, INSTALLER_EXIT_CODE } from "#src/release/installer-contract";
import {
  ActiveStateSchema,
  ComputerUpdater,
  InstalledIdentitySchema,
  ReleaseManifestSchema,
  UpdateError,
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

/** `contract/rust/installed-versions.json`: per release target, every file the installer wrote
 * under an install root for one version (`versions/<version>/...`), keyed by its path relative to
 * that root. Printable text is carried as a string; anything else as base64. Files are never
 * committed raw: the Windows launchers end lines with CRLF, which `git diff --check` reports as
 * trailing whitespace, so their bytes travel as JSON escapes (see contract/.gitattributes). */
const InstalledVersionsSchema = z.record(
  z.string(),
  z.record(
    z.string(),
    z.strictObject({ encoding: z.enum(["utf8", "base64"]), content: z.string() }),
  ),
);

async function materialize(
  files: z.infer<typeof InstalledVersionsSchema>[string],
  installRoot: string,
): Promise<void> {
  for (const [path, file] of Object.entries(files)) {
    const destination = join(installRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(file.content, file.encoding));
  }
}

test("the updater accepts the version directories the installer installs", async () => {
  // What the installer installed from a loopback release feed, for each target.
  // `prepareRollback` runs the updater's offline `#assertInstalled` over it.
  const installed = InstalledVersionsSchema.parse(
    JSON.parse(await readFile(join(RUST_OUTPUT, "installed-versions.json"), "utf8")),
  );
  expect(Object.keys(installed).sort()).toEqual(["linux-x64", "windows-x64"]);
  for (const [target, files] of Object.entries(installed)) {
    const installRoot = await scratch();
    try {
      await materialize(files, installRoot);
      const version = join(installRoot, "versions", "0.2.0");
      const identity = InstalledIdentitySchema.parse(
        JSON.parse(await readFile(join(version, "installation.json"), "utf8")),
      );
      expect(identity.schema_version).toBe(4);
      if (target.startsWith("windows-")) {
        // The byte-exact launchers, CRLF and all: the identity the installer recorded covers them.
        for (const launcher of ["coforge.cmd", "gh.cmd"]) {
          const bytes = await readFile(join(version, launcher), "latin1");
          expect(bytes).toContain("\r\n");
          expect(bytes.replaceAll("\r\n", "")).not.toContain("\n");
        }
      }
      await writeFile(
        join(installRoot, "active.json"),
        `${JSON.stringify({ schema_version: 1, current: "0.2.0", previous: "0.2.0" })}\n`,
      );
      const updater = new ComputerUpdater({
        baseUrl: "https://releases.example.invalid/",
        target,
        installRoot,
      });

      expect(await updater.prepareRollback()).toEqual({
        version: "0.2.0",
        previous: "0.2.0",
        rollbackVersion: "0.2.0",
      });

      // The same directory with one byte changed is refused, so the check above is not vacuous.
      const executable = join(
        version,
        target.startsWith("windows-") ? "coforge-computer.exe" : "coforge-computer",
      );
      await writeFile(executable, `${await readFile(executable, "utf8")}x`);
      const error = await updater.prepareRollback().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UpdateError);
      expect((error as UpdateError).code).toBe("UPDATE_INTEGRITY_FAILED");
    } finally {
      await rm(installRoot, { recursive: true, force: true });
    }
  }
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
