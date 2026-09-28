# Routine release boundary

Before any mutating deployment, verify all of the following:

- the source commit is on `main` and repository checks passed;
- the requested image or local release version and its manifest exist and
  their immutable identities resolve;
- the target has isolated secrets/credentials and a unique concurrency group;
- the track-specific configuration or feed manifest validates;
- the applicable cloud or local-package verification checks are defined;
- local distribution proves authenticated OSS read-back of every object and
  `latest` is byte-identical and unsigned/direct reads of each exact
  private-origin object key return 403;
- the previous healthy identity is recorded, or the target is verified and
  recorded as empty for a first deployment;
- no secret will enter workflow input, command arguments, logs, or artifacts;
- production has durable human approval for the exact image digest or, for a
  local distribution, the exact version string.

Routine releases may update application containers only. Shared Caddy routes,
host firewall rules, registry credentials, deployment-user permissions,
databases, and GitHub Environment protection are infrastructure changes. Make
them through separate approved work with a backup, validation, and rollback
plan; never smuggle them into an application release.

Local Computer manifest formats, code-signing/notarization keys and algorithms
(operating-system code signing, unrelated to this contract's checksum-only
release integrity model), update protocols, distribution credentials,
platform matrices, and compatibility wire fields are likewise separate
security or infrastructure changes. Review them before enabling their
operator interfaces; do not weaken the topology or per-user installation
boundaries.
