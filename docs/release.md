# CoForge release contract

Status: approved workflow contract; deployment automation is in progress

Updated: 2026-08-26

This document is the canonical release specification for CoForge. It defines
which artifact may move between environments, who authorizes that movement,
and what evidence makes a deployment or rollback complete. The project Skill
at [`.agents/skills/coforge-release`](../.agents/skills/coforge-release/SKILL.md)
implements this contract without duplicating it.

## Release invariants

- Keep one long-lived branch, `main`. Short-lived branches open a PR into
  `main`, run CI, and do not deploy. Do not add a long-lived `dev` branch.
- Build a deployable image once for a `main` commit. Record the registry digest
  returned by that build and use the digest as release identity.
- Deploy `main` automatically to the MVP `test` environment. The MVP has one
  environment and does not pretend that it is production.
- When production is introduced, promote the exact digest that passed `test`.
  Do not rebuild it and do not deploy a mutable tag such as `latest`.
- A human authorizes one exact production digest. An Agent may prepare,
  trigger, monitor, verify, and report that promotion, but must stop if the
  approval is missing, ambiguous, or names a different digest.
- Run cloud applications as Docker images in an independent Docker Compose
  project. Do not release a host binary or add an application systemd unit.
- Keep application ports private. Caddy owns the public HTTPS/WSS entry point;
  a routine application release must not rewrite shared Caddy configuration.

The `test` name does not weaken security. Login, token, attachment, and WSS
traffic still require valid HTTPS, least-privilege credentials, secret
redaction, and a non-root deployment identity.

## Release identity and evidence

Every deployment record must identify:

| Field | Meaning |
| --- | --- |
| `source_commit` | Full Git commit SHA on `main` |
| `image` | Registry and repository name |
| `image_digest` | Immutable `sha256:...` digest used by Compose |
| `environment` | `test` or `production` |
| `workflow_run` | GitHub Actions run URL or stable run ID |
| `previous_digest` | Last known healthy digest, or an explicit bootstrap marker |
| `health_result` | Internal container health plus external HTTPS health |
| `approval` | Production-only human approval bound to this digest |

Tags such as a commit SHA are useful labels, but they do not replace the
digest. Compose must ultimately resolve the service image as
`registry/repository@sha256:...`.

## Environment model

| Concern | `test` | `production` |
| --- | --- | --- |
| Trigger | Successful push to `main` | Promotion request for a tested digest |
| Authorization | Automatic | Human approves the exact digest; Agent executes |
| Artifact | Newly built immutable digest | Same digest already healthy in `test` |
| GitHub Environment | `test` | `production` |
| Compose project | `coforge-test` | `coforge-production` |
| Concurrency | One deployment at a time | One deployment at a time |
| Rollback target | Previous healthy digest or empty bootstrap state | Previous healthy digest or approved bootstrap state |

GitHub Environment secrets, variables, protection, deployment history, and
concurrency are independent from the Git branch model. Test and production
must use separate secrets, databases, volumes, networks, internal ports, and
public endpoints when both environments exist.

The MVP provisions only `test`. Production stays disabled until it has an
independent environment configuration and an enforceable human approval gate.
GitHub currently limits required reviewers for private repositories on some
plans; if the repository plan cannot enforce the gate, do not substitute an
informal blanket approval or enable production.

## Main to test

The automated path is:

1. Run the repository test, check, and build gates for the `main` commit.
2. Build and push the service image once, tagged with the full commit SHA.
3. Capture the pushed image digest as a workflow output and deployment record.
4. Enter the `test` GitHub Environment and its environment-specific
   concurrency group.
5. Set the Compose service image to the exact digest, pull it, and recreate the
   affected service without building on the server.
6. Wait for the Compose health check, then verify the public endpoint through
   valid HTTPS without bypassing certificate validation.
7. Record the digest as healthy only after both checks pass.
8. If either check fails, restore the previous healthy digest, repeat the
   checks, and report the failed candidate and rollback result. For the first
   deployment to a verified empty environment, restore the empty state.

The deployment job must fail if it cannot identify a previous healthy digest
before mutation, unless it has verified and recorded that this is the first
deployment to an empty environment. It must not improvise a host-binary,
systemd, public-port, or manual SSH release path when the Compose workflow is
unavailable.

## Test to production

Production promotion is a two-party operation:

1. An Agent prepares a promotion request containing the exact digest, source
   commit, test deployment run, test health result, change summary, known
   risks, and previous healthy production digest.
2. A human approves or rejects that exact digest through the protected
   production deployment gate. The Agent that prepared or triggered the
   promotion cannot satisfy the human gate.
3. After approval, the Agent runs or resumes the production workflow. The job
   verifies that its digest matches the approved digest and that the same
   digest is still recorded healthy in `test`.
4. The workflow deploys the digest with the production Compose project. It
   does not rebuild the image.
5. The Agent monitors internal and external health, records the result, and
   reports the final production digest.

Changing the digest invalidates the approval. A failed or cancelled attempt
does not authorize a different candidate. An approval of `latest`, a branch,
or an unspecified future release is invalid.

## Rollback

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

## Routine release boundary

Before any mutating deployment, verify all of the following:

- the source commit is on `main` and repository checks passed;
- the registry image exists and the requested digest resolves exactly;
- the environment has isolated secrets and a unique concurrency group;
- Compose configuration validates and names the intended project;
- container and external HTTPS health checks are defined;
- the previous healthy digest is recorded, or the environment is verified and
  recorded as empty for a first deployment;
- no secret will enter workflow input, command arguments, logs, or artifacts;
- production has a durable human approval for the exact digest.

Routine releases may update application containers only. Shared Caddy routes,
host firewall rules, registry credentials, deployment-user permissions,
databases, and GitHub Environment protection are infrastructure changes. Make
them through separate approved work with a backup, validation, and rollback
plan; never smuggle them into an application release.

## Implementation status

This contract intentionally does not name a registry, workflow file, Compose
file, production URL, or workflow input that the repository has not yet
implemented. The CI/CD implementation must update this document with its real
operator interface before claiming the release Skill can execute it. Until
then, the Skill may inspect, prepare evidence, and identify blockers, but it
must not invent deployment commands or mutate a server.

## Official references

- [GitHub deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Deploying with GitHub Actions](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)
- [Publishing Docker images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [Docker Compose project names](https://docs.docker.com/compose/how-tos/project-name/)
- [Docker Compose service image and health configuration](https://docs.docker.com/reference/compose-file/services/)
- [`docker compose pull`](https://docs.docker.com/reference/cli/docker/compose/pull/)
- [`docker compose up`](https://docs.docker.com/reference/cli/docker/compose/up/)
