# One-time operator bootstrap

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
   Do not generate a VAPID key during each host bootstrap. Generate one P-256
   VAPID pair once in a controlled operator environment, retain it in the
   [staging GitHub Environment values](github-environment.md), and back it up in the
   approved secret store. A deploy synchronizes the public and private halves;
   the repository and this runbook intentionally contain no real key.
   Compose file-type secrets keep their source permissions, so the rootless
   daemon user must be able to read them inside the container; keep them
   owner-readable (600) at minimum and never group/world writable.
4. Copy the tracked assets from [`infra/staging/`](../../../infra/staging) (`docker-compose.yml`,
   `caddy/Caddyfile`, `centrifugo/config.yaml`) to
   `~/coforge-staging/infra/staging/` preserving layout.
5. Attach the `coforge-staging-web` instance RAM role to the ECS host (ECS console →
   实例 → 全部操作 → 实例设置 → 授予 / 收回 RAM 角色). The role trusts `ecs.aliyuncs.com`
   and carries only the custom policy `CoForgeStagingFilesBucketAccess`:
   `oss:PutObject`/`oss:GetObject`/`oss:DeleteObject` on `workspaces/*` and `users/*` of
   the private user-files bucket `coforge-files-staging`, nothing on the release bucket.
   The Web container reads the role's STS token from the instance metadata service
   (`ALIBABA_CLOUD_ECS_METADATA` in the Compose file names the role), so no AccessKey
   pair exists anywhere in this deployment. Verify from the host:
   ```sh
   T=$(curl -s -X PUT http://100.100.100.200/latest/api/token \
     -H 'X-aliyun-ecs-metadata-token-ttl-seconds: 60')
   curl -s -H "X-aliyun-ecs-metadata-token: $T" \
     http://100.100.100.200/latest/meta-data/ram/security-credentials/
   ```
   It must print `coforge-staging-web`. Never paste the credential JSON itself anywhere.
6. Copy the CDN console's URL 鉴权 主KEY for `files-staging.coforge.cn`
   ([`aliyun-oss-cdn/` §5.3](../aliyun-oss-cdn/cdn-domains.md)/[§10](../aliyun-oss-cdn/staging-record.md)) into the repository `staging`
   Environment secret `COFORGE_FILE_DELIVERY_KEY`. The backend signs URLs with a
   fixed 1800-second TTL (`FILE_DELIVERY_TTL_SECONDS` in `file-delivery.server.ts`);
   the console's 鉴权URL有效时长 must stay at its default of 1800 seconds, or signed
   URLs will be rejected too early or stay valid longer than intended.
   To rotate: move the current key into the console's 备KEY slot first, update
   the GitHub Environment secret to the new 主KEY, then clear 备KEY only after
   waiting at least 1800 seconds so no URL signed under the old key is still
   outstanding. Never paste the key into chat.
7. Create the DNS record `staging.coforge.cn` → the ECS public address. TLS
   uses an ACME certificate over 443 (TLS-ALPN); there is no HTTP-01 path by
   design.
8. Run the first bootstrap deployment by hand to provision PostgreSQL and
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
