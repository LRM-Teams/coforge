# coforge-staging: cloud staging environment

Status: **workflow ready; credentials pending operator provisioning.**

The approved cloud application track runs as the `coforge-staging` Compose
project on a single ECS host. Caddy owns the only public entry (trusted
HTTPS on 443); application ports stay private and reach the host only through
loopback diagnostics (`18080` web, `18000` centrifugo). Port 80 is
intentionally unreachable — no plaintext, not even redirects.

## Contents

- [One-time operator bootstrap](operator-bootstrap.md): One-time host bootstrap: deployment user, secrets, RAM role, CDN signing key, DNS, and the first deploy.
- [Container logs](container-logs.md): The journald logging driver, moving the journal to the data disk, and reading logs.
- [GitHub Environment secrets (repository `staging` environment)](github-environment.md): GitHub Environment secrets and variables, bulk configuration, and when each kind of value takes effect.
- [触发 Computer 本地分发发布](computer-release-trigger.md): Triggering a local Computer distribution release to staging, and why published versions are immutable.
- [Personal GitHub connection](github-connection.md): The staging GitHub App configuration, its Environment values, and manual acceptance.
