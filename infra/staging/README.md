# coforge-staging: cloud staging environment

Status: **workflow ready; credentials pending operator provisioning.**

The approved cloud application track runs as the `coforge-staging` Compose
project on a single ECS host. Caddy owns the only public entry (trusted
HTTPS on 443); application ports stay private and reach the host only through
loopback diagnostics (`18080` web, `18000` centrifugo). Port 80 is
intentionally unreachable — no plaintext, not even redirects.

## One-time operator bootstrap

1. Provision one ECS host in an ICP-compliant region and install Docker plus
   the Compose plugin. Run Docker rootless under a dedicated non-root
   deployment user (for example `deploy`); do not deploy as `root`.
2. Create the release deployment identity on the host as a non-root user:
   ```
   sudo useradd -r -m -s /bin/bash deploy
   sudo -iu deploy mkdir -p ~/coforge-staging/infra/staging/{secrets,caddy,centrifugo}
   ```
3. Generate secrets on the host; never paste them in chat, issues, or CI logs:
   ```
   cd ~/coforge-staging/infra/staging
   for s in postgres_password redis_password centrifugo_token_hmac_secret_key \
     centrifugo_http_api_key centrifugo_proxy_secret; do
     openssl rand -hex 32 > "secrets/$s"
   done
   # Ed25519 private JWK (single-line JSON) for daemon-runtime tokens, plus a
   # stable key id. Bun can generate it on the host through the pinned image:
   docker run --rm -v "$PWD/secrets:/secrets" oven/bun:1.4.0-alpine bun -e \
     'const k = await crypto.subtle.generateKey("Ed25519", true, ["sign","verify"]); \
      await Bun.write("/secrets/worker_jwt_private_jwk", JSON.stringify(await crypto.subtle.exportKey("jwk", k)));'
   printf 'coforge-staging\n' > secrets/worker_jwt_key_id
   chmod 600 secrets/*
   ```
   Compose file-type secrets keep their source permissions, so the rootless
   daemon user must be able to read them inside the container; keep them
   owner-readable (600) at minimum and never group/world writable.
4. Copy the tracked assets from this directory (`docker-compose.yml`,
   `caddy/Caddyfile`, `centrifugo/config.yaml`) to
   `~/coforge-staging/infra/staging/` preserving layout.
5. Attach an instance RAM role granting only `oss:GetObject`/`PutObject` on the
   attachment bucket if the cloud OSS adapter needs object storage. Do not put
   AK/SK pairs in environment files.
6. Create the DNS record `staging.coforge.cn` → the ECS public address. TLS
   uses an ACME certificate over 443 (TLS-ALPN); there is no HTTP-01 path by
   design.
7. Run the first bootstrap deployment by hand to provision PostgreSQL and
   Redis volumes and apply Prisma migrations:
   ```
   ssh deploy@staging-host 'bash -s' < scripts/deploy/remote-deploy.sh -- \
     --image ghcr.io/lrm-teams/coforge/coforge-web@sha256:... \
     --compose-file ~/coforge-staging/infra/staging/docker-compose.yml \
     --secrets-dir ~/coforge-staging/infra/staging/secrets \
     --state-file ~/coforge-staging/state.env \
     --web-health-url http://127.0.0.1:18080/health \
     --public-health-url https://staging.coforge.cn/health
   ```

## GitHub Environment secrets (repository `staging` environment)

镜像直接推到 GitHub 自带的 ghcr.io（用仓库内置令牌，无需注册、无需密钥）。仓库是
public，镜像包默认公开，ECS 拉镜像不需要登录。

| 需要配的密钥（staging 环境）                             | 用途                                          |
| -------------------------------------------------------- | --------------------------------------------- |
| `DEPLOY_SSH_HOST` / `DEPLOY_SSH_USER` / `DEPLOY_SSH_KEY` | 部署时连接服务器                              |
| `DEPLOY_SSH_HOST_KEY`                                    | 服务器指纹校验                                |
| `AUTHING_APP_SECRET`                                     | Web 登录换 token                              |
| `COFORGE_SESSION_SECRET`                                 | 云端 `coforge_session` 签名密钥，须与本机不同 |
| `COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY`                | 64 位十六进制 Agent 凭据加密主密钥            |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`                     | 阿里云北京 OTLP Traces 接入地址（含 Token）  |

| 需要配的变量（staging 环境） | 用途                                |
| ---------------------------- | ----------------------------------- |
| `AUTHING_APP_ID`             | Authing 应用 ID                     |
| `STAGING_PUBLIC_HEALTH_URL`  | `https://staging.coforge.cn/health` |

部署时 workflow 把 Authing 应用 ID、应用密钥、session 密钥、Agent Runtime 凭据主密钥和 OTLP Traces
接入地址写入主机
`infra/staging/secrets/`。`remote-deploy.sh` 通过 Compose secrets 只把它们挂载给 Web；
这些值不会写入 Compose `.env`；OTLP 接入地址通过文件路径变量提供给 Web。Issuer 固定为
`https://coforge.authing.cn/oidc`，callback 固定为
`https://staging.coforge.cn/auth/callback`，变更必须走代码评审。改 GitHub Environment 后须
重新部署才会进容器。不要把这些值提交进 git，也不要在主机 bootstrap 循环里用
`openssl` 生成它们。

Production stays disabled: it needs its own environment, an enforceable human
approval gate, and promotion of the exact digest that passed staging.
