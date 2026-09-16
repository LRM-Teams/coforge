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
   Do not generate a VAPID key during each host bootstrap. Generate one P-256
   VAPID pair once in a controlled operator environment, retain it in the
   staging GitHub Environment values described below, and back it up in the
   approved secret store. A deploy synchronizes the public and private halves;
   the repository and this README intentionally contain no real key.
   Compose file-type secrets keep their source permissions, so the rootless
   daemon user must be able to read them inside the container; keep them
   owner-readable (600) at minimum and never group/world writable.
4. Copy the tracked assets from this directory (`docker-compose.yml`,
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
   (docs/operations/aliyun-oss-cdn.md §5.3/§10) into the repository `staging`
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

## GitHub Environment secrets (repository `staging` environment)

镜像直接推到 GitHub 自带的 ghcr.io（用仓库内置令牌，无需注册、无需密钥）。仓库是
public，镜像包默认公开，ECS 拉镜像不需要登录。

Secret 和 Variable 的区别不是「重不重要」，而是**能不能读回来**。Secret 写进去就再也
看不到值，所以只放真正的机密；其余放 Variable，配错时能一眼看出来，改一个主机名也不用
重设一遍。

| Secret（staging 环境）                    | 用途                                          |
| ----------------------------------------- | --------------------------------------------- |
| `DEPLOY_SSH_KEY`                          | 部署时连接服务器的私钥                        |
| `DEPLOY_SSH_HOST_KEY`                     | 服务器指纹校验                                |
| `AUTHING_APP_SECRET`                      | Web 登录换 token                              |
| `COFORGE_SESSION_SECRET`                  | 云端 `coforge_session` 签名密钥，须与本机不同 |
| `COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY` | 64 位十六进制 Agent 凭据加密主密钥            |
| `COFORGE_WEB_PUSH_PRIVATE_KEY`            | 稳定的 VAPID P-256 private key；只挂载到 Web 的只读 secret file |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`      | 阿里云北京 OTLP Traces 接入地址，**含 Token**，所以是 secret 而不是 variable |
| `COFORGE_FILE_DELIVERY_KEY`               | `files-staging.coforge.cn` 的 CDN URL 鉴权主 KEY；不是 OSS 凭据 |

| Variable（staging 环境）    | 用途                                |
| --------------------------- | ----------------------------------- |
| `DEPLOY_SSH_HOST`           | 部署目标主机名                      |
| `DEPLOY_SSH_USER`           | 部署登录用户名                      |
| `AUTHING_APP_ID`            | Authing 应用 ID                     |
| `COFORGE_WEB_PUSH_PUBLIC_KEY` | 与 private key 匹配的 URL-safe base64 VAPID public key |
| `STAGING_PUBLIC_HEALTH_URL` | `https://staging.coforge.cn/health` |

### 触发 Computer 本地分发发布

云应用走 push-to-main 自动部署，但本地 Computer/Daemon 发布是手动的（见
[`docs/release.md`](../../docs/release.md#local-computer-distribution-model)）：只挂
`workflow_dispatch`，不挂 `on: push`。触发一次 staging 发布：

```sh
gh workflow run release-staging.yml --repo LRM-Teams/coforge
# 或指定版本号，不填则自动生成 0.0.0-dev.<run_number>-<short sha>
gh workflow run release-staging.yml --repo LRM-Teams/coforge -f version=0.2.0-rc.1
```

**已发布的版本不可覆盖。** 发布前脚本会先探测 `<version>/manifest.json`，已存在就直接
报错退出——CDN 对 `<version>/*` 缓存 365 天，重发同一个版本号会让不同边缘节点长期返回
不同的字节。所以：
- 想重发内容，请换一个版本号（`-f version=...`），不要覆盖旧的；
- 对**成功**的 run 执行 `gh run rerun` 会被这条守卫拦下，这是预期行为；
- 对在 `gates` 阶段失败（比如撞上 flaky 测试）的 run 执行 `gh run rerun` 是安全的：
  那次 run 从没走到发布，manifest 不存在；
- 上传到一半失败也可以直接重跑同一个版本号：manifest 是最后一个上传的对象，
  半截的发布不会留下它。

workflow 用 GitHub OIDC 换取阿里云 RAM 角色 `coforge-release-publisher` 的临时 STS
凭据（`ALIBABA_CLOUD_ROLE_ARN` / `ALIBABA_CLOUD_OIDC_PROVIDER_ARN`，见
`.github/workflows/release-staging.yml`）——该角色的信任策略只认
`repo:LRM-Teams@289986103/coforge@1345850229:environment:staging`，没有长期 AccessKey，也就不需要在这张表
里放对应的 secret，跑 `scripts/release/publish.ts` 把 Computer/Daemon 发布到
`coforge-releases-staging` bucket（`https://releases-staging.coforge.cn`），
默认只编译四个 POSIX target（不含 Windows，见该脚本的注释）。用
`gh run watch` 或仓库 Actions 页面看进度；发布记录留在 workflow run 里，不写入本
README。

### 批量配置

一条条 `gh secret set` 在开生产环境时会很痛。`gh` 支持从文件整批导入：

```sh
# 临时文件放仓库外，用完立刻删
cat > /tmp/coforge-staging.secrets <<'EOF'
DEPLOY_SSH_KEY=...
AUTHING_APP_SECRET=...
COFORGE_SESSION_SECRET=...
COFORGE_WEB_PUSH_PRIVATE_KEY=...
EOF
gh secret set -f /tmp/coforge-staging.secrets --env staging --repo LRM-Teams/coforge
rm -f /tmp/coforge-staging.secrets

gh variable set -f /tmp/coforge-staging.vars --env staging --repo LRM-Teams/coforge
```

The variable import file must include
`COFORGE_WEB_PUSH_PUBLIC_KEY=<matching-public-key>`. Keep the VAPID private key
out of command arguments and shell history; the temporary files above must be
mode `0600` and removed immediately after import.

开生产环境时同样两条命令，把 `--env` 换成 `production`。核对配全了没有：

```sh
gh secret list --env staging --repo LRM-Teams/coforge
gh variable list --env staging --repo LRM-Teams/coforge
```

### 这些值分别在什么时候生效

同样叫「环境变量」，这个仓库里有几种完全不同的注入时机，混淆会导致「改了没反应」：

| 来源 | 谁读 | 什么时候生效 |
| --- | --- | --- |
| GitHub Environment secret / variable | 部署 workflow | workflow 运行时 |
| `infra/staging/secrets/` 下的 Compose secret | 容器里的 Web | 容器启动时；**改完要重新部署** |
| Compose `environment:` | 容器里的服务 | 同上 |
| `apps/web/.env` | 本地开发的 Web | bun 启动时自动加载 |
| `COFORGE_DAEMON_*` / `COFORGE_RELEASE_FEED_URL` | 已发布的二进制 | **编译期内联**；改环境变量无效，必须重新构建发布 |

最后一行最容易踩：那两个值看着像运行时环境变量，但它们在 `bun build --compile` 时就被
写死进二进制了。这是刻意的——见
[ADR 0007](../../docs/adr/0007-checksum-manifest-release-distribution.md)。

`COFORGE_RELEASE_FEED_URL` **有两个消费者，同一个值**：

| 消费者 | 怎么拿到 | 生效时机 |
| --- | --- | --- |
| 已发布的 Computer 二进制 | `bun build --compile` 内联 | 编译期，改环境变量无效 |
| Web 服务的 `/computer/install.sh` / `install.ps1` | Compose `environment:` | 容器启动时，改完要重新部署 |

Web 这一侧是在返回安装脚本时把脚本里写死的生产 feed 换成本部署的 feed，
这样 `curl https://staging.coforge.cn/computer/install.sh | sh` 装的是 staging 版本
而不是生产版本（`docs/release.md` 的 "Local Computer distribution model"）。
**没配这个变量时这两个端点返回 503，不会返回一个指向错误 feed 的 200。**

部署时 workflow 把 Authing 应用 ID、应用密钥、session 密钥、Agent Runtime 凭据主密钥、
VAPID public/private key 和 OTLP Traces 接入地址写入主机
`infra/staging/secrets/`。`remote-deploy.sh` 校验 key pair，并只在调用 Compose 时从受限文件
读取 private key 作为 Compose secret source；Compose 再以
`/run/secrets/coforge_web_push_private_key` 只读挂载给非 root Web 进程，并设置容器内
`COFORGE_WEB_PUSH_PUBLIC_KEY`、`COFORGE_WEB_PUSH_PRIVATE_KEY_FILE` 和非 secret
`COFORGE_WEB_PUSH_SUBJECT=https://coforge.cn`；
这些值不会写入 Compose `.env`；OTLP 接入地址通过文件路径变量提供给 Web。Issuer 固定为
`https://coforge.authing.cn/oidc`，callback 固定为
`https://staging.coforge.cn/auth/callback`，Authing 应用还必须允许 logout redirect URL
`https://staging.coforge.cn/`。变更必须走代码评审。改 GitHub Environment 后须重新部署才会
进容器。不要把这些值提交进 git，也不要在主机 bootstrap 循环里用 `openssl` 生成它们。

VAPID pair 必须跨发布、重启和 Web 副本保持稳定。轮换会使已有浏览器 subscription
需要重新订阅，因此必须作为受控维护操作执行；更新 GitHub Environment 中匹配的两个
值并重新部署，不能只更新一半。

Production stays disabled: it needs its own environment, an enforceable human
approval gate, and promotion of the exact digest that passed staging.

## Personal GitHub connection

The staging App ID is `4937758`, Client ID is `Iv23lip3Ca7BRl50L2O4`, and its
authorization callback must be
`https://staging.coforge.cn/api/integrations/github/callback`.
Keep expiring user access tokens enabled. Repository discovery requires Metadata
(read). Agent HTTPS Git and the planned GitHub operations require repository
permissions Actions (read), Checks (read), Contents (write), Pull requests
(write), Commit statuses (read), and Workflows (write); no organization-member or
email permission is needed. Installation and personal authorization are separate
actions. Existing installations must approve changed permissions and select the
repositories Agents may use.
Set Webhook Active, with URL `https://staging.coforge.cn/api/integrations/github/webhook`
and the generated webhook secret below. No event subscription is needed:
GitHub delivers `installation`, `installation_repositories` and
`github_app_authorization` to every GitHub App automatically, and none of them
appears under Permissions & events. The callback URL and the Webhook URL are
different endpoints; do not point one at the other.

Set these in the repository's **staging Environment** before a reviewed deployment:

- Variable `COFORGE_GITHUB_APP_SLUG`: the actual slug from the App's public URL
  (`https://github.com/apps/<slug>`), not its display name or numeric ID.
- Secret `COFORGE_GITHUB_CLIENT_SECRET`: generated in the GitHub App settings.
- Secret `COFORGE_GITHUB_CREDENTIAL_ENCRYPTION_KEY`: independently generated
  32-byte key encoded as 64 hexadecimal characters. Generate and store securely;
  never send it through chat. Retain this key across deployments. Replacing it
  makes existing ciphertext unreadable; users must disconnect and reconnect.
- Secret `COFORGE_GITHUB_WEBHOOK_SECRET`: independently generated, entered
  verbatim as the GitHub App's webhook secret. Optional: absent, the webhook
  route responds 503 and Settings falls back to its background/manual sync
  only, so this can be provisioned after the rest of the connection works.

Keep **Request user authorization (OAuth) during installation** enabled. GitHub
therefore disables the Setup URL and sends installation completion to the existing
authorization callback above. Leave **Redirect on update** disabled: GitHub ignores
it when the Setup URL is blank. CoForge validates a browser-bound installation
`state`, ignores the untrusted returned installation ID, and resynchronizes through
the authenticated GitHub user token. Later repository-access changes arrive through
GitHub webhooks and are also refreshed when Settings or the Project repository selector loads.

The workflow transfers these through restricted files. Compose mounts credentials
as secrets; none is stored in its `.env` or Web container environment.
Absent connection credentials leave the Settings integration unconfigured without
changing login behavior. This does not configure production or deploy automatically.

Settings no longer polls GitHub on every page load: it reads a database cache
and refreshes it in the background, kept fresh by the three webhook events
above (installation, installation_repositories, github_app_authorization). See
[ADR 0019](../../docs/adr/0019-github-installation-cache-and-webhooks.md).

Manual acceptance after configuration and approved migration/deployment:

- [ ] Open Settings → Integrations in light/dark and desktop/narrow layouts.
- [ ] Connect, accept GitHub authorization, and return to the same signed-in User.
- [ ] Cancel authorization; confirm a safe error and a working retry.
- [ ] Change account; GitHub shows its account picker. Cancellation or failed
  authorization retains the old connection; successful authorization replaces it.
- [ ] Configure opens GitHub's App installation page for a personal account or
  organization, where repository grants are managed. No repository list is shown
  on the CoForge integration card.
- [ ] Revoke authorization on GitHub; reopen Settings to request reauthorization.
- [ ] Disconnect; confirm the account disappears and the App remains installed.
- [ ] With the webhook secret configured, suspend then unsuspend the installation
  on GitHub; Settings reflects the change without a manual Refresh.
- [ ] Uninstall the App on GitHub; Settings shows "pending installation" without
  a manual Refresh.

Local database regression command (disposable migrated PostgreSQL only):
`GITHUB_TEST_DATABASE_URL=<local-url> mise exec -- bun test ./apps/web/test/github-connection.integration.ts`.
Tests substitute GitHub HTTP responses; they do not prove a live OAuth exchange.
