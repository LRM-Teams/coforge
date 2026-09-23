# 10. Staging 实际配置记录（2026-09-04）

生产环境尚未 provision。以下是 staging 已经执行并验证过的状态，供后续 operator 和
Agent 参照，不要按前面的步骤重复创建。

| | `files-staging.coforge.cn` | `releases-staging.coforge.cn` |
| --- | --- | --- |
| bucket | `coforge-files-staging` | `coforge-releases-staging` |
| 业务类型 | 图片小文件 | 大文件下载 |
| 加速区域 | 仅中国内地 | 仅中国内地 |
| 私有 Bucket 回源 | 已开启（同账号 STS，只读） | 已开启（同账号 STS，只读） |
| URL 鉴权 | **开启**，未签名即 `403` | **不开启**——安装与更新必须匿名可取 |
| 证书 | `cert-d7orsd` | `cert-a4kn7` |
| 协议重定向 | `HTTP -> HTTPS` | `HTTP -> HTTPS` |
| Delete Cookie / Set-Cookie | 均已配置 | 均已配置 |

两个 bucket 都是私有 + 阻止公共访问 + OSS 完全托管加密（AES256），华北 2（北京），
标准存储、同城冗余。

`cert-d7orsd`（2026-12-02 到期）与 `cert-a4kn7`（2026-12-03 到期）是阿里云免费
个人测试证书路径下签发的最后一批证书——该路径已随 2026-02-24 的 SSL 证书付费
订阅化改动关闭，无法在控制台重新签发。这两个域名连同 2026-09-20 新建、尚未有
任何证书的 `images-staging.coforge.cn`，现在由 acme.sh + Let's Encrypt 自动
签发和续期，取代了这条已关闭的人工续期路径；证书生命周期的完整 runbook见
[`cdn-certificates/`](../cdn-certificates/README.md)，不再在本节维护。

验证过的行为，可用 `curl -sI` 复现：

- `https://files-staging.coforge.cn/` → `403` + `X-Tengine-Error: denied by req auth:
  no url arg auth_key`（签名鉴权 fail closed）
- `https://releases-staging.coforge.cn/latest` → 目前 `404` + `x-oss-cdn-auth: success`
  （回源授权正常，只是还没有发布过任何产物）
- 两个域名的 `http://` 均返回 `301` 到 `https://`

`releases-staging` 的缓存规则已按新的 feed 布局改好（2026-09-05）：

| 匹配 | 类型 | 过期 | 强制回源验证 | 权重 |
| --- | --- | --- | --- | --- |
| `json` | 文件后缀名 | 0 秒 | 开启 | 99 |
| `/latest` | 目录 | 0 秒 | 开启 | 99 |
| `/` | 目录 | 365 天 | 关闭 | 80 |

`manifest.json` 用后缀匹配而不是 `/*/manifest.json`，因为阿里云的「目录」类型不支持
通配符；feed 里只有 manifest 是 `.json`，覆盖范围正好。权重 99 压过全目录那条，否则
`latest` 会被 365 天规则盖住，发布了新版本客户端读不到，而且失败是静默的。

`<version>/<target>/coforge-computer.sha256` 落在 365 天那条规则下，这是对的：sidecar
和它描述的二进制一样按版本不可变。

backend 现在为 `files-staging.coforge.cn` 签发 Type A 签名 URL
（`apps/web/src/server/files/file-delivery.server.ts`）：`COFORGE_FILE_DELIVERY_URL`、
`COFORGE_FILE_DELIVERY_KEY`/`COFORGE_FILE_DELIVERY_KEY_FILE` 两个环境变量携带该配置，
签名 key 与 console 的 URL 鉴权主 KEY 一致，不是 OSS 凭据。有效时长是代码里固定的
`FILE_DELIVERY_TTL_SECONDS = 1800`，不是环境变量；console 的鉴权URL有效时长必须维持
默认值 1800 秒。

CDN real-time log delivery 与 OSS access logging 两项 staging 均**未启用**，属于已知
缺口：出事时没有取证能力。
