# coforge-test: cloud test environment

Status: **workflow ready; credentials pending operator provisioning.**

The approved cloud application track runs as the `coforge-test` Compose
project on a single ECS host. Caddy owns the only public entry (trusted
HTTPS on 443); application ports stay private and reach the host only through
loopback diagnostics (`18080` web, `18000` centrifugo). Port 80 is
intentionally unreachable — no plaintext, not even redirects.

## One-time operator bootstrap

1. Provision one ECS host in an ICP-compliant region and install Docker plus
   the Compose plugin.
2. Create the release deployment identity on the host as a non-root user:
   ```
   sudo useradd -r -m -d /opt/coforge coforge
   sudo -u coforge mkdir -p /opt/coforge/test/{secrets,caddy,centrifugo}
   ```
3. Generate secrets on the host; never paste them in chat, issues, or CI logs:
   ```
   cd /opt/coforge/test
   for s in postgres_password redis_password centrifugo_token_hmac_secret_key \
     centrifugo_http_api_key centrifugo_proxy_secret; do
     openssl rand -hex 32 > "secrets/$s"
   done
   chmod 600 secrets/*
   ```
4. Copy the tracked assets from this directory (`docker-compose.yml`,
   `caddy/Caddyfile`, `centrifugo/config.yaml`) to
   `/opt/coforge/test/` preserving layout; make them `coforge:coforge 0644`.
5. Attach an instance RAM role granting only `oss:GetObject`/`PutObject` on the
   attachment bucket if the cloud OSS adapter needs object storage. Do not put
   AK/SK pairs in environment files.
6. Create the DNS record `test.coforge.cn` → the ECS public address. TLS uses
   an ACME certificate over 443 (TLS-ALPN); there is no HTTP-01 path by
   design.
7. Run the first bootstrap deployment by hand to provision PostgreSQL and
   Redis volumes and apply Prisma migrations:
   ```
   ssh coforge@test-host 'bash -s' < scripts/deploy/remote-deploy.sh -- \
     --image REGISTRY/coforge/web@sha256:... \
     --compose-file /opt/coforge/test/docker-compose.yml \
     --secrets-dir /opt/coforge/test/secrets \
     --state-file /opt/coforge/test/state.env \
     --web-health-url http://127.0.0.1:18080/health \
     --public-health-url https://test.coforge.cn/health
   ```

## GitHub Environment secrets (repository `test` environment)

镜像直接推到 GitHub 自带的 ghcr.io（用仓库内置令牌，无需注册、无需密钥）。ECS 拉镜像时若包是私有的，配置时会一并处理。

| 需要配的密钥（test 环境） | 用途 |
| --- | --- |
| `DEPLOY_SSH_HOST` / `DEPLOY_SSH_USER` / `DEPLOY_SSH_KEY` | 部署时连接服务器 |
| `DEPLOY_SSH_HOST_KEY` | 服务器指纹校验 |
| `TEST_PUBLIC_HEALTH_URL` | `https://test.coforge.cn/health` |

Production stays disabled: it needs its own environment, an enforceable human
approval gate, and promotion of the exact digest that passed test.
