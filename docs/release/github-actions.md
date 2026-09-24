# Reading GitHub Actions

| Workflow                       | When it runs                        | Steps                                                                                    |
| ------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| **CI**                         | A pull request is opened or updated | Plan checks → validate affected packages and scripts → CI passed                         |
| **Deploy Web (staging)**       | A commit reaches `main`             | Validate → build and push Docker image → deploy and verify Web                           |
| **Publish Computer (staging)** | Manually started from `main`        | Validate → build all six platforms → upload and verify release → update staging `latest` |

The Web workflow skips image build and deployment when the commit does not
affect Web. Computer publication is manual and its run title includes the
version. Its build, upload, integrity checks, and selector update stay together
in one publication transaction; expand that step to see each platform and object.

`Validate` reuses CI. Package jobs run tests, static checks, and a build where
applicable; separate jobs check macOS lifecycle, Windows executables, and the
Windows installer. These checks can run in parallel. `CI passed` is the final
required check and keeps its existing name for branch protection.

CI has one reusable validation definition in `.github/workflows/ci.yml`, invoked
with three scopes selected by `scripts/ci/selection.ts`:

- Pull requests validate changed modules and affected downstream consumers.
  Web-only changes run Web gates; Daemon changes also validate Computer.
  Agent changes additionally validate Web's imported Agent test contract.
  Client module changes retain native macOS and Windows smoke checks;
  PowerShell installer changes run both PowerShell parsers and lint. Both
  installers are embedded in the Web image, so changing either also validates Web.
- Each `main` push checks whether the Web image or deployment inputs changed.
  If so, the exact main commit runs Web, protocol, and deploy-script gates before
  building and deploying the image. Client-only and documentation-only pushes
  do not build an image or deploy. There is no second standalone CI workflow
  for that main push.
- Manual local publication always runs the complete local track for its exact
  selected main commit: protocol, Agent, CLI, Computer, Daemon, release scripts,
  native macOS/Windows checks, and Windows installer checks. It does not run
  unrelated Web, deployment, or OSS/CDN acceptance-verifier checks.

Shared protocol, global toolchain/configuration, lockfile, CI, and unclassified
paths select full PR coverage. Only known documentation locations are exempt;
Markdown assets inside source directories remain code inputs. Documentation-only
PRs run CI-policy tests, workflow/static lint, and changed-line whitespace checks,
not application builds. No documentation link checker is currently configured.
PR diffs use the merge base; a push diffs from the head of the last successful
run of the same workflow on that branch, so commits whose runs were superseded,
cancelled, or failed stay in scope. Renames include both old and new paths, and
a push with no earlier successful run gets full coverage.

Every run ends with `CI passed`, which requires selection/static validation and
every selected job to succeed. An unexpectedly skipped, failed, cancelled, or
missing selected job cannot pass. Configure branch protection to require this
aggregate rather than individual conditional/matrix job names; changing that
GitHub setting requires separate authorization. PR updates cancel stale PR
checks; release-track checks do not cancel an active publication or deployment.
The cloud workflow keeps GitHub's default single pending run: a newer push to
`main` replaces a waiting one, and the running deployment is never cancelled, so
staging converges on the latest commit. Because the replacement diffs from the
last successful run, a later documentation-only push still deploys a Web change
it superseded.

Module-owned test/check/build commands remain unchanged. Local full validation
still uses `mise run test`, `mise run check`, and `mise run build`; CI-policy
regressions can be exercised alone with `bun run test:ci` and `bun run check:ci`.
Track-specific pre-release validation is not replaced by a mutable "latest
successful CI" result. Docker image builds and version/feed-specific
cross-compilation remain independent artifact builds, not redundant gates.

Publishing a local-distribution release is **manual**. The workflow exposes only
`workflow_dispatch`; it is not triggered by merging to `main`. Continuous publish
on merge suits the cloud application, which replaces a running service, but a
client release leaves a persistent artifact set behind, and at the current user
count a build per merge is waste. Adding a trigger later is one line.

Routine staging publications use `<target-version>-dev.<workflow-run-number>`;
the current target is `0.1.0`, so leaving the workflow's version input empty
generates versions such as `0.1.0-dev.9` and `0.1.0-dev.10`. Run numbers may
have gaps and are not reset when the target version changes. Update the
workflow's default target when preparing the next release line. The source SHA
and build time remain in the manifest rather than the version string. There
is no nightly schedule or date-based version convention. Use only two routine
forms: staging builds such as `0.1.0-dev.9` and stable versions such as `0.1.0`,
selected through the explicit version input. No beta or release-candidate
stage is required. Previously published versions, including historical `rc`
versions, remain immutable and available by exact version; the next successful
publication moves `latest` without renaming or deleting them. Retrying a
partially published version must still respect the write-once rule; use a new workflow run for a fresh
default version rather than overwriting an existing version.

The Computer distribution is published to the release feed only. It is **not
published to npm**; that channel is purely additive and can be introduced later
without changing anything here.
