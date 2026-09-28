# Staging to production

## Cloud application

Cloud production promotion is a two-party operation:

1. An Agent prepares a promotion request containing the exact digest, source
   commit, staging deployment run, staging health result, change summary, known
   risks, migration compatibility, production configuration revision, and
   previous healthy production digest.
2. A human approves or rejects that exact digest through the protected
   production deployment gate. The Agent that prepared or triggered the
   promotion cannot satisfy the human gate.
3. After approval, the Agent runs or resumes the production workflow. The job
   verifies that its digest matches the approved digest and that the same
   digest is still recorded healthy in `staging`.
4. The workflow deploys the digest with the production Compose project. It
   does not rebuild the image.
5. The Agent monitors internal and external health, records the result, and
   reports the final production digest.

Changing the digest invalidates the approval. A failed or cancelled attempt
does not authorize a different candidate. An approval of `latest`, a branch,
an unspecified future release, or a commit without its full `sha256:...` digest
is invalid.

## Local Computer distribution

The local Computer distribution uses the same two-party boundary, but what
crosses it is the **source commit and its evidence, not the artifact**. Staging
and production binaries cannot be the same bytes: the feed a build trusts is
compiled into it, so a staging binary copied into the production feed would keep
updating itself from staging. Promotion therefore rebuilds:

1. An Agent verifies the staging feed's `latest` resolves a stable version (no
   prerelease suffix). It prepares that version, the source commit it was built
   from, the staging test run and its evidence, and the production feed's
   current `latest` for comparison.
2. A human approves or rejects that exact commit and version. A filename,
   branch, channel name, or unspecified "latest build" approval is invalid.
3. After approval, the Agent builds the approved commit against the production
   feed configuration, producing a distinct set of binaries whose only intended
   difference from the staging set is the compiled-in environment (feed and
   matching business server addresses).
4. The Agent publishes the new manifest, checksum sidecars and binaries beneath
   the production feed's `<version>/` path, then performs authenticated OSS
   byte-identical read-back and verifies the unsigned-origin 403 guard for each
   object.
5. Only after that confirmation does the Agent write the production feed's
   `latest` pointer to the approved version.
6. The Agent re-reads the production feed's `latest` through authenticated OSS
   access, verifies its exact bytes and unsigned-origin 403 guard, runs the
   production local-distribution checks, and records the result.

Building a commit other than the approved one, or altering the source between
approval and build, invalidates the approval. Because the artifacts are rebuilt
rather than copied, the production checks in
[Health verification](health-verification.md#local-computer-distribution) are the evidence
that the production binaries work — the staging evidence attests to the commit,
not to those bytes.
