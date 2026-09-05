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
   private user-files bucket if the cloud OSS adapter needs object storage. Do not put
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
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`      | 阿里云北京 OTLP Traces 接入地址，**含 Token**，所以是 secret 而不是 variable |
| `ALIYUN_OSS_ACCESS_KEY_ID`                | 发布产物上传用的 RAM 用户                     |
| `ALIYUN_OSS_ACCESS_KEY_SECRET`            | 同上                                          |

| Variable（staging 环境）    | 用途                                |
| --------------------------- | ----------------------------------- |
| `DEPLOY_SSH_HOST`           | 部署目标主机名                      |
| `DEPLOY_SSH_USER`           | 部署登录用户名                      |
| `AUTHING_APP_ID`            | Authing 应用 ID                     |
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

workflow 读取上面同一张表里的 `ALIYUN_OSS_ACCESS_KEY_ID` / `ALIYUN_OSS_ACCESS_KEY_SECRET`，
跑 `scripts/release/publish.ts` 把 Computer/Daemon 发布到
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
EOF
gh secret set -f /tmp/coforge-staging.secrets --env staging --repo LRM-Teams/coforge
rm -f /tmp/coforge-staging.secrets

gh variable set -f /tmp/coforge-staging.vars --env staging --repo LRM-Teams/coforge
```

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
