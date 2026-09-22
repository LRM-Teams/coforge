import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PHOTON_WASM_FILE, resolvePhotonWasmBytes } from "./photon-wasm";

// The real dependency chain, resolved from this repository's own installed node_modules -
// scripts/release/publish.ts resolves exactly the same bytes Pi's own image-resize code loads at
// runtime, which is the whole point of the fix: a hand-copied or separately pinned wasm could
// silently drift from what Pi actually bundles.
test("resolvePhotonWasmBytes resolves the exact photon_rs_bg.wasm Pi's dependency ships", async () => {
  const bytes = await resolvePhotonWasmBytes();

  // Pinned against the installed @silvia-odwyer/photon-node@0.3.4 package (a transitive
  // dependency of @earendil-works/pi-coding-agent@0.84.3 declared in packages/agent/package.json).
  expect(bytes.byteLength).toBe(1881634);
  expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(
    "10468181565c56004c867f3a4af96f89a0ef5a63a72f2b5fb12c1f1992a3615c",
  );
});

test("resolvePhotonWasmBytes walks the exact dependency chain, not a hardcoded node_modules path", async () => {
  // A fixture tree standing in for node_modules: packages/agent -> @earendil-works/pi-coding-agent
  // -> @silvia-odwyer/photon-node, resolved the same way real package managers lay out nested
  // dependencies, so this proves the walk itself (not just today's real install) is correct.
  const fixtureAgent = await mkdtemp(join(tmpdir(), "coforge-photon-wasm-fixture-"));
  try {
    const piDirectory = join(fixtureAgent, "node_modules/@earendil-works/pi-coding-agent");
    const photonDirectory = join(piDirectory, "node_modules/@silvia-odwyer/photon-node");
    await mkdir(piDirectory, { recursive: true });
    await mkdir(photonDirectory, { recursive: true });
    await writeFile(
      join(piDirectory, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.0.0-fixture" }),
    );
    await writeFile(
      join(photonDirectory, "package.json"),
      JSON.stringify({ name: "@silvia-odwyer/photon-node", version: "0.0.0-fixture" }),
    );
    const fixtureBytes = Buffer.from("#wasm-fixture: photon_rs_bg.wasm\n");
    await writeFile(join(photonDirectory, PHOTON_WASM_FILE), fixtureBytes);

    const resolved = await resolvePhotonWasmBytes(fixtureAgent);

    expect(Buffer.from(resolved).equals(fixtureBytes)).toBe(true);
  } finally {
    await rm(fixtureAgent, { recursive: true, force: true });
  }
});

test("resolvePhotonWasmBytes fails closed when the dependency chain is absent", async () => {
  const emptyDirectory = await mkdtemp(join(tmpdir(), "coforge-photon-wasm-empty-"));
  try {
    await expect(resolvePhotonWasmBytes(emptyDirectory)).rejects.toThrow();
  } finally {
    await rm(emptyDirectory, { recursive: true, force: true });
  }
});
