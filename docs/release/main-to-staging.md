# Main to staging

## Cloud application

The automated cloud path is:

1. Run the Web-track test, check, and build gates for the latest `main` commit,
   covering every change since the last successful run.
2. Build and push the service image once, tagged with the full commit SHA.
3. Capture the pushed image digest as a workflow output and deployment record.
4. Enter the `staging` GitHub Environment and its environment-specific
   concurrency group.
5. Validate the Compose configuration, including the Centrifugo configuration
   checked by running Centrifugo's own `checkconfig` subcommand inside the
   pinned Centrifugo image, before any service is recreated; set the service
   image to the exact digest, pull it, and recreate the affected service with
   `--no-build`.
6. Use a bounded wait for Compose health, then run the complete verification set
   in [Health verification](health-verification.md#cloud-application).
7. Record the digest as healthy only after every required check passes.
8. If any check fails, restore the previous healthy release - the image
   digest and the shipped configuration (Compose file, Caddyfile, and
   Centrifugo configuration) together - repeat the checks, and report the
   failed candidate and rollback result. For the first deployment to a
   verified empty environment, restore the empty state.

The deployment job must fail if it cannot identify a previous healthy digest
before mutation, unless it has verified and recorded that this is the first
deployment to an empty environment. It must not improvise a host-binary,
systemd, public-port, or manual SSH release path when the Compose workflow is
unavailable.

## Local Computer distribution

The automated local-distribution path always publishes the unified executable,
built from both source packages, to the track's own feed (a staging build trusts a different
`COFORGE_RELEASE_FEED_URL` than a production build compiles in, so the two
tracks' `latest` pointers are never the same object):

1. Run the complete local-track gates for the exact `main` commit.
2. Build the unified Computer executable once for the complete Windows, Linux,
   and macOS platform matrix, with the approved Bun executable targets and the
   same release version injected into both Computer and Daemon roles.
   Do not rebuild one platform after another platform passed.
3. Compute every platform's Computer executable byte size and SHA-256 checksum,
   resolve Pi's `photon_rs_bg.wasm` bytes from the installed dependency chain
   (`scripts/release/photon-wasm.ts`) and its own identity, assemble the
   schema 2 `manifest.json` (its additive `photonWasm` field), and generate
   each platform's `coforge-computer.sha256` sidecar from the same Computer
   binary bytes and the same checksum computation as the manifest entry - the
   two must never be allowed to diverge.
4. Publish `manifest.json`, every platform's `coforge-computer.sha256`
   sidecar, every platform's sole `coforge-computer.gz`, and the one
   platform-independent `photon_rs_bg.wasm` beneath the new `<version>/`
   prefix on the staging feed. Re-read every object through authenticated OSS
   access and compare it byte-for-byte with the workflow source, then prove
   unsigned anonymous/direct reads of the exact private-origin keys return 403.
5. Only after every object under `<version>/` is published and verified,
   write the staging feed's `latest` pointer to the new version. A publish
   that fails before this step leaves an unreferenced version directory that
   no installer will ever resolve.
6. Re-read `latest` through authenticated OSS access, verify its exact bytes and
   unsigned-origin 403 guard, then run the local-distribution checks in
   [Health verification](health-verification.md#local-computer-distribution)
   against the version it resolves.
7. Record the version and its manifest checksums as healthy only after every
   required check passes.
8. On failure, leave the staging feed's `latest` pointing at the last healthy
   version - do not advance it - and record the candidate and its failure.
   For a verified first publication, leave `latest` unpublished; installers
   continue to fail closed for that unpublished feed.

An alpha or prerelease-labelled version ends here. A stable version is not
production-ready merely because it carries no prerelease suffix: the exact
version must pass this staging path first. The workflow must not publish
directly to the production feed, publish an incomplete platform matrix, or
treat a partial publication as approval for the whole version.
