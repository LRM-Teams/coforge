# GitHub Environment secrets (repository `staging` environment)

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

## 批量配置

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

## 这些值分别在什么时候生效

同样叫「环境变量」，这个仓库里有几种完全不同的注入时机，混淆会导致「改了没反应」：

| 来源 | 谁读 | 什么时候生效 |
| --- | --- | --- |
| GitHub Environment secret / variable | 部署 workflow | workflow 运行时 |
| `infra/staging/secrets/` 下的 Compose secret | 容器里的 Web | 容器启动时；**改完要重新部署** |
| Compose `environment:` | 容器里的服务 | 同上 |
| `apps/web/.env` | 本地开发的 Web | bun 启动时自动加载 |
| `COFORGE_DAEMON_*` / `COFORGE_RELEASE_FEED_URL` | 已发布的二进制 | **编译期内联**；改环境变量无效，必须重新构建发布 |

最后一行最容易踩：那两个值看着像运行时环境变量，但它们在 `bun build --compile` 时就被
写死进二进制了。这是刻意的：发行版不做签名，靠 checksum manifest 校验。

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
