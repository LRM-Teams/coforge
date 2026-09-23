# Rollback

Each release track records its own previous known-healthy identity before
mutation. A rollback in one track does not change another track implicitly.

## Cloud application

A health failure during an approved deployment transaction automatically
authorizes restoration of the recorded previous healthy digest. This is part
of the same release transaction and must not wait for a second approval while
the service is unhealthy.

For a verified first deployment, rollback restores the recorded pre-deployment
empty state by stopping and removing the failed candidate. Never treat a
missing release record on a non-empty environment as bootstrap.

An unrelated later rollback request must identify its target digest and follow
the production authorization gate unless a separately approved incident policy
explicitly says otherwise.

Rollback means redeploying a known healthy image digest. It is not a Git
revert, rebuild, or mutable retag. Database changes must be backward compatible
with the previous application digest; otherwise application rollback is not a
valid recovery plan and the release must not proceed.

## Local Computer distribution

If staging publication or production verification fails, leave the affected
feed's `latest` pointing at its last healthy version - do not advance it -
verify the restored selector through authenticated OSS read-back and its
unsigned-origin 403 guard, and verify installation again. Because both
components always publish together, there is no separately unchanged peer to
preserve.

Devices that already activated a failed version use the local versioned
installation directory to stop the processes, reactivate the retained
previous Computer installation, restart Computer and Daemon, and repeat
health checks. If persisted state or protocol changes make this unsafe,
production promotion must remain disabled until a reviewed forward-repair
path exists.

Local-distribution rollback reselects and reactivates recorded immutable bytes.
It does not rebuild old source, copy an unverified file into a release path, or
assume that a lower display version is installable. An unrelated later
production rollback requires human approval of the exact target version
unless a separately approved incident policy says otherwise.
