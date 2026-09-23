# Release identity and evidence

Every deployment or local-distribution publication record must identify:

| Field                         | Meaning                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source_commit`               | Full Git commit SHA on `main`; host-initiated rollback uses the explicit `manual` sentinel and remains bound to immutable image digests             |
| `track`                       | Cloud application or local Computer distribution                                                                                                    |
| `artifact_identity`           | Cloud image digest or local release version and its manifest's SHA-256                                                                              |
| `artifact_members`            | Image reference or, per platform, the unified Computer executable's name, size, and SHA-256 checksum                                                |
| `environment_or_channel`      | Isolated `staging` or `production` target                                                                                                           |
| `workflow_run`                | GitHub Actions run URL or stable run ID; host-initiated rollback uses the explicit `manual` sentinel                                                |
| `previous_identity`           | Last known healthy digest/manifest, or an explicit bootstrap marker; cloud JSONL names this `previous_digest`                                       |
| `verification_result`         | Track-specific internal, public, shared-ingress, running-identity, install, upgrade, and integrity evidence; cloud JSONL names this `health_result` |
| `approval`                    | Production-only human approval bound to the exact artifact identity                                                                                 |
| `executor`                    | Agent or human that executed the deployment                                                                                                         |
| `started_at` / `completed_at` | UTC transaction boundaries                                                                                                                          |
| `outcome`                     | Healthy, failed, rolled back, or failed rollback                                                                                                    |

Tags, versions, filenames, and channel names are useful labels, but they do not
replace immutable identity. Compose must ultimately resolve a cloud service as
`registry/repository@sha256:...`; a local `latest` pointer must resolve an
exact version whose manifest and every downloaded binary also match their
recorded SHA-256 checksums.
