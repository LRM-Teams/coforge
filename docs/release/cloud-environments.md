# Cloud environment model

| Concern            | `staging`                                        | `production`                                        |
| ------------------ | ------------------------------------------------ | --------------------------------------------------- |
| Trigger            | Successful push to `main`                        | Promotion request for a tested digest               |
| Authorization      | Automatic                                        | Human approves the exact digest; Agent executes     |
| Artifact           | Newly built immutable digest                     | Same digest already healthy in `staging`            |
| GitHub Environment | `staging`                                        | `production`                                        |
| Compose project    | `coforge-staging`                                | `coforge-production`                                |
| Concurrency        | One deployment at a time                         | One deployment at a time                            |
| Rollback target    | Previous healthy digest or empty bootstrap state | Previous healthy digest or approved bootstrap state |

GitHub Environment secrets, variables, protection, deployment history, and
concurrency are independent from the Git branch model. Staging and production
must use separate secrets, databases, volumes, networks, internal ports, and
public endpoints when both environments exist.

Every Compose invocation must pass the intended project explicitly with `-p`;
do not derive it from a checkout directory. Render and validate the effective
base-plus-environment configuration before mutation. Environment secrets must
not be committed, echoed, placed in command arguments, or copied into release
records.

The MVP provisions only `staging`. Production stays disabled until it has an
independent environment configuration and an enforceable human approval gate.
GitHub currently limits required reviewers for private repositories on some
plans; if the repository plan cannot enforce the gate, do not substitute an
informal blanket approval or enable production.
