# 阿里云 OSS/CDN provisioning runbook

状态：**staging 两个域名已上线**（见第 10 节的实际记录）；生产的
`files.coforge.cn` 与 `releases.coforge.cn` 仍待 operator 执行，尚不可按本文视为已上线。
profile image 域名 `images.coforge.cn`（及 staging 对应域名）staging 与生产都**尚未
provision**，第 11 节是它的执行清单。
backend OSS adapter 已实现（`apps/web/src/server/files/oss-file-storage.server.ts`，
由 `COFORGE_FILE_STORAGE=oss` 启用）；浏览器直传（PostObject policy）与 CDN
URL-signed 下载仍是后续步骤，尚未实现。

适用范围：三个 private content bucket、三个加速域名 `files.coforge.cn`、
`releases.coforge.cn` 与 `images.coforge.cn`、最小权限 RAM、访问日志、验收与回滚

profile image 域名（头像与项目图标，[ADR 0052](../adr/0052-public-profile-image-delivery.md)）
是第三个 trust zone，staging 与生产都尚未 provision；第 11 节是它的专用步骤，其余各节
的通用要求同样适用。

本文把 [`architecture.md`](../architecture.md) 和
[`release.md`](../release.md) 已批准的边界转换为 operator 步骤，不改变应用授权或
发行协议。所有 `${...}` 均为执行时参数，不能原样提交到控制台。

## 1. 开始前的硬门禁

Frank 或其明确授权的阿里云 operator 必须先在变更记录中填写以下值；任何一项缺失都
停止在本节，不创建资源：

| 参数 | 要求 |
| --- | --- |
| `${ACCOUNT_ID}` | 两个 content bucket 与 CDN 必须在同一个阿里云账号；跨账号私有回源会要求长期 AK/SK，本方案禁止 |
| `${REGION}` | 两个 content bucket 与 OSS 日志 sink 使用同一 Region；由 Frank 定稿，不从仓库或 bucket 名推断 |
| `${ACCELERATION_AREA}` | 中国内地或全球加速要求有效 ICP；两个域名各自确认备案覆盖，未完成时不得选择这两项或切 CNAME |
| `${FILES_BUCKET}` | 全局唯一的私有用户文件 bucket 名；只承载聊天附件，不能包含环境外的业务含义 |
| `${IMAGES_BUCKET}` | 全局唯一的 profile image bucket 名（头像、项目图标），且不得等于 `${FILES_BUCKET}` 或 `${RELEASES_BUCKET}`；该域名不签名，bucket 内全部对象等同公开 |
| `${RELEASES_BUCKET}` | 全局唯一的发行 bucket 名，且不得等于 `${FILES_BUCKET}` |
| `${LOG_BUCKET}` | 已有的同账号同 Region private 日志 sink，或新建专用日志 bucket；不得作为 CDN origin |
| `${SLS_PROJECT}` / `${SLS_LOGSTORE}` | CDN real-time access log 的受限 SLS 目标与 retention |
| `${OPERATOR}` | 启用 MFA 的专用 RAM console user；不能使用聊天中的 AccessKey |
| `${FILES_URL_TTL}` | backend 与 CDN 一致的短时私有文件 URL TTL；验收可先用 console generator |

执行前先禁用并轮换任何曾在聊天中发送的长期 AK/SK。本 runbook 不需要把 AK/SK 写入
命令、文件或 CI；同账号 private OSS origin 必须选择阿里云推荐的 STS 临时 token
模式。

## 2. 目标拓扑与对象映射

```text
files.coforge.cn/<object_key>
  -- URL signing + no POP cache --> ${FILES_BUCKET}/<object_key>

releases.coforge.cn/<release_path>
  -- public + immutable cache --> ${RELEASES_BUCKET}/<release_path>

releases.coforge.cn/channels.json
  -- public + revalidate --> ${RELEASES_BUCKET}/channels.json

images.coforge.cn/<object_key>
  -- anonymous + immutable cache --> ${IMAGES_BUCKET}/<object_key>
```

三个域名是三个 trust zone（见 [ADR 0006](../adr/0006-split-cdn-delivery-domains.md) 与
[ADR 0052](../adr/0052-public-profile-image-delivery.md)）。每个域名只有一个 origin，
路径与 object key 一一对应，不做业务前缀 rewrite，也不使用 conditional origin；客户端
看不到 OSS hostname。

阿里云的 same-account private OSS origin access 使用 STS，但授权是**账号级只读**，
且官方文档明确「开启后，该加速域名将可以访问其源站私有 Bucket 内的所有资源，无法在
CDN 侧对 Bucket 内的部分资源做访问限制」。因此跨类隔离不是靠授权范围，而是靠「每个
域名只有一个 origin bucket 且不改写路径」：一个域名的请求永远只会到它自己的 bucket。
由此三个 content bucket 都不能混放其他业务数据——尤其是 `${IMAGES_BUCKET}`，它的域名
不签名，混入其中的任何对象都等同公开——`${LOG_BUCKET}` 同样不得成为 origin。

## 3. 建立最小权限身份

1. Frank 在 RAM 创建 console-only user `${OPERATOR}`，强制 MFA，不创建 AccessKey。
2. 只授予本次变更需要的 action；禁止附加 `AliyunOSSFullAccess`、
   `AliyunCDNFullAccess` 或 `ram:*`。
3. bucket 创建阶段只有 `oss:PutBucket` 与 `oss:PutBucketAcl` 可以使用
   `acs:oss:*:${ACCOUNT_ID}:*`。两个名字创建成功后立即把 resource 收窄为：
   `acs:oss:*:${ACCOUNT_ID}:${FILES_BUCKET}`、
   `acs:oss:*:${ACCOUNT_ID}:${FILES_BUCKET}/*`、
   `${RELEASES_BUCKET}` 对应两项，以及 `${LOG_BUCKET}` 的日志写入 prefix。
4. 收窄后的 OSS action 仅保留：`oss:GetBucketInfo`、
   `oss:GetBucketLocation`、`oss:GetBucketAcl`、`oss:PutBucketAcl`、
   `oss:GetBucketLogging`、`oss:PutBucketLogging`、
   `oss:DeleteBucketLogging`、canary 所需的 `oss:PutObject`、
   `oss:GetObject`、`oss:DeleteObject` 和 `oss:ListObjects`。`oss:DeleteBucket` 仅在
   rollback 窗口临时加入。
5. CDN action 按 domain ARN
   `acs:cdn:*:${ACCOUNT_ID}:domain/files.coforge.cn` 与
   `acs:cdn:*:${ACCOUNT_ID}:domain/releases.coforge.cn` 收窄：
   `cdn:AddCdnDomain`、`cdn:DescribeCdnUserDomains`、
   `cdn:DescribeCdnDomainDetail`、`cdn:BatchSetCdnDomainConfig`、
   `cdn:DescribeCdnDomainConfigs`、`cdn:BatchDeleteCdnDomainConfig`、
   `cdn:SetCdnDomainCSRCertificate`、`cdn:RefreshObjectCaches`、
   `cdn:DescribeRefreshTasks`、`cdn:CreateRealTimeLogDelivery` 与
   `cdn:DescribeDomainRealtimeLogDelivery`。某个 action 的官方授权表若标记为
   `All Resources`，只对该 action 使用 `*`，不要扩大同 statement 的其他 action。
6. CDN private-origin 与 real-time-log service roles 由 Frank 在服务授权页面确认创建；
   不给 `${OPERATOR}` RAM 管理权限。完成后记录 role/policy 名和 ARN，不记录 credential。
7. 验收完成后撤销 `${OPERATOR}` 的变更权限并删除该临时 user。后续 release publisher、
   attachment upload signer 和 backend download signer 分别使用独立 role；不能复用
   provisioner 身份。

## 4. 创建 private OSS origins 与日志

对 `${FILES_BUCKET}`、`${RELEASES_BUCKET}`、`${IMAGES_BUCKET}` 分别执行：

1. 在 `${REGION}` 创建 Standard bucket，ACL 选择 `private`。
2. 保持 Block Public Access 开启；不得添加 anonymous principal、`public-read`、
   `public-read-write`、static website hosting 或 object-level public ACL。
3. 记录 bucket ARN、Region、ACL 与 Block Public Access 状态。不要在 Issue、PR 或公开
   日志中记录 endpoint。
4. 在 Logging > Logging 开启 OSS access logging，目标选择同账号同 Region 的
   `${LOG_BUCKET}`：附件使用 `oss/files/` prefix，发行使用 `oss/releases/` prefix，
   profile image 使用 `oss/images/` prefix。
   `${LOG_BUCKET}` 自身保持 private、Block Public Access，并配置经批准的 lifecycle；
   不把 source bucket 自己设为 log sink，避免日志递归。

私有用户文件 bucket 只允许 canonical key
`workspaces/{workspace_id}/attachments/{attachment_id}/original`；profile image bucket
只允许 `users/{user_id}/avatars/{avatar_id}/original` 与
`workspaces/{workspace_id}/projects/{project_id}/icons/{icon_id}/original`；发行 bucket 只允许
[`release.md`](../release.md) 定义的 immutable trees、`channels.json` 与 installer
入口。第 6 节的随机 `acceptance/` canary 是上线前唯一临时例外，验收后必须删除；不要
提前创建目录占位对象。

## 5. 配置加速域名

在 CDN console 分别添加精确域名 `files.coforge.cn`、`releases.coforge.cn` 与
`images.coforge.cn`，不要使用 wildcard。只有第 1 节的 ICP / 加速区域门禁对相应域名
满足后，才能继续上线和切 CNAME。

每个域名只有一个 origin，因此不配置 conditional origin、origin path rewrite 或
EdgeScript：域名边界本身就是 fail-closed 的，一个域名请求另一类对象只会因为该 object
不在它的 origin bucket 里而失败。

### 5.1 源站与回源 HOST

| 域名 | origin type | origin | 回源 HOST | 路径处理 |
| --- | --- | --- | --- | --- |
| `files.coforge.cn` | OSS | `${FILES_BUCKET}` | 该 bucket 域名 | 不 rewrite |
| `releases.coforge.cn` | OSS | `${RELEASES_BUCKET}` | 该 bucket 域名 | 不 rewrite |
| `images.coforge.cn` | OSS | `${IMAGES_BUCKET}` | 该 bucket 域名 | 不 rewrite |

不使用 Advanced Origin，不添加第二个 origin。任何一个域名出现第二个 origin 都视为配置
偏离，停止上线。

### 5.2 私有回源

对每个域名执行：

1. 在 Origin Fetch > Alibaba Cloud OSS Private Bucket Access 点击授权。
2. 选择 `Bucket in the Same Account`，启用 STS temporary token 模式。
3. 确认生成的 CDN service role 为 OSS read-only。该授权是账号级的，**不要**记录成
   「只对本域名的 origin bucket 生效」；真正的边界是本域名只配置了这一个 origin
   bucket，第 6 节的跨域名探针验证的正是这一点。
4. 禁止选择需要输入 bucket owner AK/SK 的 `Across Accounts` 模式。
5. 不把 OSS presigned query 作为 CDN origin URL；client CDN signing 与 origin STS 是
   两条独立认证链。

### 5.3 URL signing、cache 与 headers

1. 只为 `files.coforge.cn` 启用 CDN URL signing，作用于整个域名而不是某条规则条件；
   建议 Type A，并让 backend Secret 与 CDN primary/secondary key、`${FILES_URL_TTL}`
   完全一致。验收阶段使用 console Signed URL Generator，key 不写入 acceptance JSON、
   shell history 或日志。
2. `releases.coforge.cn` 与 `images.coforge.cn` 不启用 client URL signing。release 的
   公开性由 artifact signature/digest 验证承担；profile image 的访问控制是不可枚举的
   object key 本身（ADR 0052）。两者 OSS origin 仍保持 private。
   `images.coforge.cn` 因为没有签名可作速率约束，必须另外配置带宽封顶与流量告警
   （阿里云对匿名可读域名的推荐防护）。
3. Cache > Cache Expiration 按下表设置。higher weight 优先，禁止 Ignore Origin
   No-Cache：

   | 域名 | match | POP TTL | weight | client `Cache-Control` |
   | --- | --- | --- | --- | --- |
   | `releases.coforge.cn` | `/latest` | `0`, Force Revalidation | `99` | `no-cache, must-revalidate` |
   | `releases.coforge.cn` | `/*/manifest.json` | `0`, Force Revalidation | `99` | `no-cache, must-revalidate` |
   | `releases.coforge.cn` | `/` | `31536000` seconds | `80` | `public, max-age=31536000, immutable` |
   | `files.coforge.cn` | `/` | `0` | `80` | `private, no-store` |
   | `images.coforge.cn` | `/` | `31536000` seconds | `80` | `public, max-age=31536000, immutable` |

   POP TTL 与 outgoing response header 是两个配置：前者控制 CDN cache，后者控制 client；
   两者都必须设置和验收。
4. 不在 `files.coforge.cn` 配置会忽略 CDN signing 参数的 Ignore Parameters 或 custom
   cache key。CDN 先验签，再用去掉鉴权材料后的规范化 path 作为 cache 身份。
5. 三个域名都新增全域 Modify Outgoing Request Headers `Delete Cookie` 与 Modify
   Outgoing Response Headers `Delete Set-Cookie`。应用 session cookie 必须是 application
   host-only，不能设置 `Domain=.coforge.cn`。CDN 不用 Cookie 鉴权或形成 cache identity。
6. 启用 HTTPS 证书后强制 HTTPS；每个域名各自记录 certificate ID/expiry，不导出私钥。
   一张 `*.coforge.cn` 证书可以覆盖多个域名，但域名配置本身不得使用 wildcard。

### 5.4 访问日志

1. 为每个域名分别激活 CDN Real-Time Log Delivery，选择 `${SLS_PROJECT}` /
   `${SLS_LOGSTORE}` 和经批准 retention（初始建议 7 天）。
2. 确认各 delivery 状态均为 `Succeeded`，并能按 domain 维度分别查询。
3. SLS 日志可能含短时 URL signing 参数，应按 credential-equivalent 数据限制读取；
   Issue/PR 只保存脱敏计数和 request ID，不粘贴原始 URI。

## 6. 上线前 acceptance gate

在各 bucket 写入随机、不可复用的 canary bytes：

- files：`acceptance/<nonce>/files.bin`；
- releases：`acceptance/<nonce>/release.bin`；
- releases：首次合法、已签名的 `/channels.json` bytes（不能用假 schema 覆盖已有对象）；
- images：`acceptance/<nonce>/image.png`——必须是**真实图片**，因为它要经过图片样式
  处理（profile image 域名上线时才需要，见第 11 节）。

分别计算本地 SHA-256。用 CDN console 为 files canary 和
`https://files.coforge.cn/acceptance/<nonce>/release.bin` 生成短时 signed URL；后者是
release object key 拿到附件域名上请求，带**有效签名**，专门验证它仍读不到 release
bucket——被拒的原因必须是缺少回源授权，而不是缺少签名。复制
[`oss-cdn-acceptance.example.json`](oss-cdn-acceptance.example.json) 到仓库外权限为
`0600` 的临时文件，替换 URL 与 hash，然后执行：

```bash
mise run verify:oss-cdn -- --input /secure/runtime/oss-cdn-acceptance.json \
  > /secure/runtime/oss-cdn-acceptance-report.json
```

工具会发送一个无权限意义的 canary Cookie，但只输出脱敏 check ID/detail。以下全部为
PASS 才能切 DNS：

- 两个 private origin 的三个已知 exact-key anonymous GET 都返回 `403`；
- unsigned `files.coforge.cn` 返回 `403`；signed 附件、public release、public
  `channels.json` 都返回 `200` 且 SHA-256 与源 bytes 相同；
- 附件响应为 `private, no-store`，immutable release 至少缓存 30 天，
  `channels.json` 要求 revalidate；
- 四个跨域名探针都返回非 redirect `4xx`：files-through-releases、
  release-through-files，以及 profile image 域名上线后的 files-through-images
  （附件 key 向不签名的 image 域名发起的无签名请求，这一条证明公开域名读不到私有
  用户文件）与 image-through-files（image key 带**有效签名**向附件域名请求）；
- image canary 的**样式 URL**（`?x-oss-process=style/avatar192`）匿名返回 `200`，响应为
  `public, max-age=31536000, immutable`。这里不比对 SHA-256：边缘返回的是样式处理后的
  派生图，本地算不出它的哈希；图片的身份由「源站匿名仍然 403」和「只接受具名样式」
  两条共同保证；
- 成功响应没有 `Location`、`Set-Cookie` 或任一 OSS hostname。

另外为每个域名各保存一份脱敏的 `DescribeCdnDomainConfigs`/console evidence，证明单一
origin、私有回源授权、POP TTL、Cookie deletion 与 real-time log delivery 配置存在，
且 `releases.coforge.cn` 与 `images.coforge.cn` 没有启用 URL signing。`images` 域名另需
三份证据：保留 `x-oss-process` 参数的「保留指定参数」配置、带宽封顶与流量告警、以及
bucket 的原图保护状态与已定义样式列表。这三项是匿名域名唯一的滥用上界，行为探针
覆盖不到，必须留配置证据。行为探针本身不能观察 CDN→OSS 的 Cookie
header，所以这份配置证据是必需门禁，不可用“带 Cookie 也下载成功”替代。

最后才把各域名的 DNS CNAME 指向 CDN 分配的 CNAME。等待 DNS/CDN 配置生效后，用
consumer-visible hostname 重跑完整 gate；任何一项失败立即执行回滚。

## 7. Evidence record

变更记录只保存：operator、UTC 时间、账号 ID 后四位、Region、两个 domain、两类 bucket ARN 的
脱敏标识、RAM policy/role ID、CDN config ID、SLS task ID、DNS change ID、验收报告 JSON
和 rollback target。不得保存：AccessKey、URL signing key、signed URL、完整 OSS endpoint、
原始 CDN/SLS 日志或 canary bytes。

## 8. 回滚与删除

按以下逆序执行，任一步失败就停止并保留当前 evidence：

1. 把 backend delivery adapter 保持/切回 Direct OSS；旧 CDN signed URL 至少保留到
   `${FILES_URL_TTL}` 结束。
2. 撤销相关域名到 CDN 的 DNS change，或恢复上一条已知健康记录。回滚可以按域名单独
   执行：撤附件域名不影响安装与更新，反之亦然；撤 image 域名前先取消 Web 的
   `COFORGE_IMAGE_DELIVERY_URL` 与 `COFORGE_IMAGE_OSS_BUCKET`，头像随即回到已认证路由。
3. purge 相关域名；确认 consumer hostname 不再命中新配置。
4. 停止 CDN real-time log delivery，删除 response/request header rules、cache rules 与
   URL signing，再移除 accelerated domain。
5. 撤销该域名的 CDN private OSS access service role 授权。
6. 关闭各 source bucket 的 logging；保留 `${LOG_BUCKET}` 到审计 retention 结束。
7. 删除 canary objects。仅当相关 content bucket 从未承载真实附件/发行制品且已确认
   empty 时，临时加入 `oss:DeleteBucket` 并删除 bucket；否则不删数据，只撤流量与权限。
8. 撤销并删除 `${OPERATOR}`。记录 healthy rollback 或 failed rollback，不用“资源看起来
   已消失”替代验证。

## 9. 官方依据

- [Configure an origin server](https://www.alibabacloud.com/help/en/cdn/user-guide/configure-an-origin-server)
- [Private OSS origin access](https://www.alibabacloud.com/help/en/cdn/user-guide/grant-alibaba-cloud-cdn-access-permissions-on-private-oss-buckets)
- [URL signing](https://www.alibabacloud.com/help/en/cdn/user-guide/configure-url-signing)
- [Cache expiration](https://www.alibabacloud.com/help/en/cdn/user-guide/configure-the-cdn-cache-expiration-time)
- [Modify origin request headers](https://www.alibabacloud.com/help/en/cdn/user-guide/configure-custom-request-headers)
- [CDN real-time logs](https://www.alibabacloud.com/help/en/cdn/user-guide/configure-real-time-log-delivery)
- [OSS RAM policies](https://www.alibabacloud.com/help/en/oss/user-guide/ram-policy/)
- [OSS Block Public Access](https://www.alibabacloud.com/help/en/oss/how-to-prevent-the-creation-of-public-read-and-write-buckets)
- [OSS access logging](https://www.alibabacloud.com/help/en/oss/user-guide/logging)

## 10. Staging 实际配置记录（2026-09-04）

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
[`cdn-certificates.md`](cdn-certificates.md)，不再在本节维护。

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

## 11. Profile image 域名（尚未 provision）

头像与项目图标是第三个内容类：匿名、不签名、永不过期的 URL，访问控制是不可枚举的
object key 本身（[ADR 0052](../adr/0052-public-profile-image-delivery.md)）。这一节是它
在 staging 与生产的执行清单；前面各节的通用要求（private bucket、Block Public Access、
单一 origin、Cookie 删除、HTTPS、日志）同样适用，不在此重复。

为什么必须是独立 bucket：阿里云私有回源授权无法限制到 bucket 内的部分对象，URL 鉴权
又是按域名的开关。只要一个不签名的域名指向附件 bucket，附件就从「必须签名」降级成
「知道 key 即可下载」。Slack 的做法同样是两套域名（`avatars.slack-edge.com` 与
`files.slack.com`）；Discord 用同一个 `cdn.discordapp.com` 按路径区分，那是自研边缘才
有的能力，阿里云 CDN 给不了。

执行顺序：

1. 按第 4 节创建 `${IMAGES_BUCKET}`（同账号、同 Region、`private`、Block Public
   Access），logging prefix `oss/images/`。该 bucket 只允许
   `users/{user_id}/avatars/{avatar_id}/original` 与
   `workspaces/{workspace_id}/projects/{project_id}/icons/{icon_id}/original` 两种 key。
2. 在该 bucket 创建图片样式，名字必须与代码里的 `PROFILE_IMAGE_STYLES` 完全一致：
   `avatar192`（等比缩放宽 192，不放大）与 `icon256`（等比缩放宽 256，不放大）。
   Web 发出的每个 profile image URL 都带 `?x-oss-process=style/<name>`，样式不存在就是
   全站头像 400。存原图不做变体是不可接受的：上传上限 5 MB，而头像最大只画到约 96px。
3. 把现有对象从 `${FILES_BUCKET}` 复制到 `${IMAGES_BUCKET}`：上述两个 key 前缀，key 保持
   完全不变（两个 bucket 布局相同，所以不改数据库、不改 key、不需要发版）。确认逐个对象
   的 SHA-256 一致后，再从 `${FILES_BUCKET}` 删除这两个前缀。
4. 按第 5 节添加域名：staging 是 `images-staging.coforge.cn` 回源
   `coforge-images-staging`，生产是 `images.coforge.cn` 回源生产 `${IMAGES_BUCKET}`。单一 origin
   指向 `${IMAGES_BUCKET}`，开启同账号 STS 私有回源，**不启用** URL 鉴权，缓存与响应头
   按 5.3 表格的 `images` 行设置为 `public, max-age=31536000, immutable`。
   `images-staging.coforge.cn` 的 HTTPS 证书不走控制台手动上传：它已经是
   [`cdn-certificates.md`](cdn-certificates.md) 里 `scripts/ops/renew-cdn-certificates.sh`
   覆盖的三个域名之一，按该文档第 5 节跑一次首次签发即可，之后自动续期。
5. 在该域名的性能优化里把「忽略参数」改成**保留指定参数**并保留 `x-oss-process`。
   CDN 默认过滤 `?` 之后的全部参数，不改这一项样式参数根本到不了 OSS：结果不是报错，
   而是静默回退成原图，慢但能显示——所以必须按第 6 节实测样式 URL 的响应大小。
6. 开启 bucket 的**原图保护**，使匿名请求只能通过具名样式访问，任意
   `x-oss-process` 表达式被拒；记录它在 CDN 私有回源（回源请求自带签名）下的实际
   行为，因为原图保护官方说明「仅对匿名访问有效，带签名访问无效」，这条对经 CDN 的
   请求是否成立必须实测确认，不能照抄推断。
7. 配置带宽封顶与流量告警。这个域名没有签名可作速率约束；若上一步的原图保护在 CDN
   路径上不生效，封顶就是唯一的滥用上界。
8. 按第 6 节跑 acceptance gate，`image` 探针与两条新的跨域名探针必须 PASS，然后切
   CNAME 并用 consumer hostname 重跑。验收输入里三个域名必须同属一个环境——三个都是
   `*-staging.coforge.cn` 或三个都是生产域名，混用会被 `input_contract` 直接拒绝，
   免得用 staging 的 image 域名去"证明"生产附件域名的边界。
9. 全部 PASS 后才在 Web 的 compose 里同时启用 `COFORGE_IMAGE_OSS_BUCKET` 与
   `COFORGE_IMAGE_DELIVERY_URL`（两者必须同时设置，只设 URL 会在启动时直接失败）。
   部署后 `curl -sI https://<web>/health | grep -i x-coforge-image-delivery` 应为
   `configured`，页面上的头像 URL 应指向 image 域名。

回滚：取消这两个环境变量即可，下一次响应起头像回到已认证路由；已经发出去的 image URL
在域名删除前仍然可读。
