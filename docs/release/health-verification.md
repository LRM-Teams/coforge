# Health verification

## Cloud application

A release is healthy only when every applicable check passes within its
documented timeout:

1. Compose reports each required service running and healthy through a
   meaningful container health check; process existence alone is insufficient.
2. The host-local readiness endpoint passes through its intended loopback or
   internal route.
3. The public HTTPS readiness endpoint passes with normal certificate
   verification. Never use `--insecure` to make a release pass.
4. A minimal functional smoke check exercises the released path, including WSS
   connection behavior when realtime transport changes.
5. Existing routes that share host ingress remain healthy.
6. The running container resolves to the requested digest and matches the
   deployment record.

Compose health is necessary but does not replace external or functional
verification. Capture failure diagnostics without secrets.

The Web Docker build also starts the isolated runtime payload as its runtime
user, with networking disabled and fixture configuration only, and checks
`/health` plus both Computer installer responses before publication. The
`apps/web/test/production.integration.ts` check catches SSR initialization errors
that a successful bundle build cannot detect. Nitro's documented
[`inlineDynamicImports`](https://nitro.build/config#inlinedynamicimports) option
currently avoids cyclic server-chunk initialization; browser splitting is unchanged.
This workaround does not replace staging checks with real dependencies.

Before automatic rollback, `remote-deploy.sh` reports allowlisted container
state, exit/restart counts, health state, loopback HTTP status, and fixed startup
error signatures. It examines at most 80 log lines from five minutes, capped at
16 KiB; raw logs, health bodies, URLs, and arbitrary error text are never printed.
Three Docker reads each have a five-second deadline plus one-second forced-kill
grace period; the HTTP probe has a five-second timeout. Missing diagnostics do
not prevent rollback or alter its outcome.

After every healthy deployment, `remote-deploy.sh` snapshots the shipped
Compose file, Caddyfile, and Centrifugo configuration to `$REMOTE_ROOT/last-healthy/`
before recording the release healthy. Rollback restores those files from that
snapshot ahead of restoring the image, because the deploy workflow overwrites
their live paths before `remote-deploy.sh` ever runs, so a configuration
regression - not only an image regression - would otherwise survive rollback.
The first deployment after this change has no snapshot yet and falls back to
restoring the image digest alone, with a stderr note saying so.

## Local Computer distribution

Staging development publication and production readiness are separate gates.
Following the 2026-09-09 user direction to fix the release process and include
Windows, routine staging development versions publish all six targets. They
require repository gates (including native Windows x64/arm64 release identity
and environment-binding smoke tests), plus checks 1–3 below for every published
object. Missing install/upgrade/lifecycle evidence must be reported explicitly;
it is not silently counted as passing and does not prevent publishing a
development candidate for testing. No partial platform publication is allowed.
Stable-version production promotion additionally requires checks 4–8 for every
target; publishing Windows bytes still requires Job Object APIs at runtime for
external Agent process trees (`ProcessTreeOwner`); when those APIs cannot be
loaded the launch remains fail-closed.

A local Computer release version is production-ready only when:

1. the feed's `latest` pointer resolves the requested version and no other;
2. the version's schema 2 manifest, every downloaded platform Computer executable, and the
   downloaded `photon_rs_bg.wasm` match their recorded byte sizes and SHA-256 checksums;
3. an unsigned anonymous/direct GET of each exact private OSS object key is
   rejected with 403, while authenticated OSS read-back for every version object
   and `latest` is byte-identical to the workflow's source bytes;
4. clean per-user Computer install and supported per-user upgrade checks pass
   without a separate Daemon install or elevation on every required target
   platform/architecture;
5. both installed processes report the expected version and reach their
   local readiness boundaries;
6. computer-to-daemon Unix-socket and protocol compatibility passes for the
   declared version, including a workspace-child startup smoke test;
7. stable machine identity, credentials, configuration, and application data
   survive the version-store activation; and
8. the previous Computer installation remains installed or recoverable and a
   rollback rehearsal can reactivate it without network access.

The implementation must define the required platform matrix and exact command
seams before a local distribution channel can be promoted.

An upgrade or rollback coordinator must execute outside the managed service's
kill scope. Under native management it acquires the machine mutation lock for
the complete transaction, prepares and verifies bytes, persists launch-hold
with the exact request ID,
snapshots the exact running Workspace set, holds the runners and waits for them
to quiesce (see [The runner hold](upgrade-operations.md#the-runner-hold)), asks `systemd --user` or per-user `launchd` to stop the
Supervisor, activates the target, and restarts the manager. A replacement
Coordinator born while launch-hold exists loads its bindings and exposes local
control but does not start Workspace children. Candidate health requires a new
Supervisor identity reporting the expected version; it does not require
Workspace children to be online. The coordinator writes the terminal receipt
before resume. Resume first settles that receipt into the affected child config,
then removes the internal pause and starts enabled Workspace children, whose
first cloud ready can therefore report the already-durable result. The same
held-recovery seam is bound to the request ID stored in launch-hold and is also invoked by receipt
watcher/startup settlement: if the external job exits after receipt commit or loses the resume
response, the Coordinator still resumes that exact verified operation and clears launch-hold; an
unrelated terminal receipt cannot release it. Legacy hold files select the newest operation by
`requestedAt`. Candidate
Supervisor failure automatically restores the prior immutable installation,
probes that Supervisor, records the rollback result, and only then resumes.
Once a candidate or rollback receipt is committed, a later Workspace child
startup failure is a separate Workspace lifecycle fault and never rewrites the
Computer result or rolls the executable back. Failed Supervisor rollback keeps
launches held for explicit recovery. A foreground externally supervised instance
cannot currently be stopped by this coordinator and must be stopped through its
external supervisor before upgrade.
