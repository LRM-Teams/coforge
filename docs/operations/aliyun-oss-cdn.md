# 阿里云 OSS/CDN provisioning runbook

状态：待 operator 执行；`files.coforge.cn` 与 `releases.coforge.cn` 尚不可按本文视为
已上线

适用范围：两个 private content bucket、两个加速域名 `files.coforge.cn` 与
`releases.coforge.cn`、最小权限 RAM、访问日志、验收与回滚

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
| `${FILES_BUCKET}` | 全局唯一的附件 bucket 名；不能包含环境外的业务含义 |
| `${RELEASES_BUCKET}` | 全局唯一的发行 bucket 名，且不得等于 `${FILES_BUCKET}` |
| `${LOG_BUCKET}` | 已有的同账号同 Region private 日志 sink，或新建专用日志 bucket；不得作为 CDN origin |
| `${SLS_PROJECT}` / `${SLS_LOGSTORE}` | CDN real-time access log 的受限 SLS 目标与 retention |
| `${OPERATOR}` | 启用 MFA 的专用 RAM console user；不能使用聊天中的 AccessKey |
| `${FILES_URL_TTL}` | backend 与 CDN 一致的短时附件 URL TTL；验收可先用 console generator |

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
```

两个域名是两个 trust zone（见 [ADR 0006](../adr/0006-split-cdn-delivery-domains.md)）。
每个域名只有一个 origin，路径与 object key 一一对应，不做业务前缀 rewrite，也不使用
conditional origin；客户端看不到 OSS hostname。跨类访问由授权而非规则拦截：release
域名没有附件 bucket 的读取授权，反之亦然。

阿里云的 same-account private OSS origin access 使用 STS，但其 CDN service role 对所选
origin bucket 是 bucket-wide read-only，不能限制到单个 object。因此两个 content
bucket 都不能混放第三类数据，`${LOG_BUCKET}` 尤其不能成为 origin。

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

对 `${FILES_BUCKET}`、`${RELEASES_BUCKET}` 分别执行：

1. 在 `${REGION}` 创建 Standard bucket，ACL 选择 `private`。
2. 保持 Block Public Access 开启；不得添加 anonymous principal、`public-read`、
   `public-read-write`、static website hosting 或 object-level public ACL。
3. 记录 bucket ARN、Region、ACL 与 Block Public Access 状态。不要在 Issue、PR 或公开
   日志中记录 endpoint。
4. 在 Logging > Logging 开启 OSS access logging，目标选择同账号同 Region 的
   `${LOG_BUCKET}`：附件使用 `oss/files/` prefix，发行使用 `oss/releases/` prefix。
   `${LOG_BUCKET}` 自身保持 private、Block Public Access，并配置经批准的 lifecycle；
   不把 source bucket 自己设为 log sink，避免日志递归。

附件 bucket 只允许 canonical key
`workspaces/{workspace_id}/attachments/{attachment_id}/original`；发行 bucket 只允许
[`release.md`](../release.md) 定义的 immutable trees、`channels.json` 与 installer
入口。第 6 节的随机 `acceptance/` canary 是上线前唯一临时例外，验收后必须删除；不要
提前创建目录占位对象。

## 5. 配置两个加速域名

在 CDN console 分别添加精确域名 `files.coforge.cn` 与 `releases.coforge.cn`，不要使用
wildcard。只有第 1 节的 ICP / 加速区域门禁对两个域名都满足后，才能继续上线和切 CNAME。

每个域名只有一个 origin，因此不配置 conditional origin、origin path rewrite 或
EdgeScript：域名边界本身就是 fail-closed 的，一个域名请求另一类对象只会因为缺少回源
授权而失败。

### 5.1 源站与回源 HOST

| 域名 | origin type | origin | 回源 HOST | 路径处理 |
| --- | --- | --- | --- | --- |
| `files.coforge.cn` | OSS | `${FILES_BUCKET}` | 该 bucket 域名 | 不 rewrite |
| `releases.coforge.cn` | OSS | `${RELEASES_BUCKET}` | 该 bucket 域名 | 不 rewrite |

不使用 Advanced Origin，不添加第二个 origin。任何一个域名出现第二个 origin 都视为配置
偏离，停止上线。

### 5.2 私有回源

对两个域名分别执行：

1. 在 Origin Fetch > Alibaba Cloud OSS Private Bucket Access 点击授权。
2. 选择 `Bucket in the Same Account`，启用 STS temporary token 模式。
3. 确认生成的 CDN service role 为 OSS read-only，且**只对本域名的那一个 origin bucket
   生效**；确认另一个 content bucket 不在授权范围内。
4. 禁止选择需要输入 bucket owner AK/SK 的 `Across Accounts` 模式。
5. 不把 OSS presigned query 作为 CDN origin URL；client CDN signing 与 origin STS 是
   两条独立认证链。

### 5.3 URL signing、cache 与 headers

1. 只为 `files.coforge.cn` 启用 CDN URL signing，作用于整个域名而不是某条规则条件；
   建议 Type A，并让 backend Secret 与 CDN primary/secondary key、`${FILES_URL_TTL}`
   完全一致。验收阶段使用 console Signed URL Generator，key 不写入 acceptance JSON、
   shell history 或日志。
2. `releases.coforge.cn` 不启用 client URL signing；公开性由 artifact signature/digest
   验证承担，OSS origin 仍保持 private。
3. Cache > Cache Expiration 按下表设置。higher weight 优先，禁止 Ignore Origin
   No-Cache：

   | 域名 | match | POP TTL | weight | client `Cache-Control` |
   | --- | --- | --- | --- | --- |
   | `releases.coforge.cn` | `/channels.json` | `0`, Force Revalidation | `99` | `no-cache, must-revalidate` |
   | `releases.coforge.cn` | `/` | `31536000` seconds | `80` | `public, max-age=31536000, immutable` |
   | `files.coforge.cn` | `/` | `0` | `80` | `private, no-store` |

   POP TTL 与 outgoing response header 是两个配置：前者控制 CDN cache，后者控制 client；
   两者都必须设置和验收。
4. 不在 `files.coforge.cn` 配置会忽略 CDN signing 参数的 Ignore Parameters 或 custom
   cache key。CDN 先验签，再用去掉鉴权材料后的规范化 path 作为 cache 身份。
5. 两个域名都新增全域 Modify Outgoing Request Headers `Delete Cookie` 与 Modify
   Outgoing Response Headers `Delete Set-Cookie`。应用 session cookie 必须是 application
   host-only，不能设置 `Domain=.coforge.cn`。CDN 不用 Cookie 鉴权或形成 cache identity。
6. 启用 HTTPS 证书后强制 HTTPS；两个域名各自记录 certificate ID/expiry，不导出私钥。
   一张 `*.coforge.cn` 证书可以覆盖两个域名，但域名配置本身不得使用 wildcard。

### 5.4 访问日志

1. 为两个域名分别激活 CDN Real-Time Log Delivery，选择 `${SLS_PROJECT}` /
   `${SLS_LOGSTORE}` 和经批准 retention（初始建议 7 天）。
2. 确认两个 delivery 状态均为 `Succeeded`，并能按 domain 维度分别查询。
3. SLS 日志可能含短时 URL signing 参数，应按 credential-equivalent 数据限制读取；
   Issue/PR 只保存脱敏计数和 request ID，不粘贴原始 URI。

## 6. 上线前 acceptance gate

在两个 bucket 写入随机、不可复用的 canary bytes：

- files：`acceptance/<nonce>/files.bin`；
- releases：`acceptance/<nonce>/release.bin`；
- releases：首次合法、已签名的 `/channels.json` bytes（不能用假 schema 覆盖已有对象）。

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
- files-through-releases 与 release-through-files 两个跨域名探针都返回非 redirect
  `4xx`；
- 成功响应没有 `Location`、`Set-Cookie` 或任一 OSS hostname。

另外为两个域名各保存一份脱敏的 `DescribeCdnDomainConfigs`/console evidence，证明单一
origin、私有回源授权范围、POP TTL、Cookie deletion 与 real-time log delivery 配置存在，
且 `releases.coforge.cn` 没有启用 URL signing。行为探针本身不能观察 CDN→OSS 的 Cookie
header，所以这份配置证据是必需门禁，不可用“带 Cookie 也下载成功”替代。

最后才把两个域名的 DNS CNAME 指向 CDN 分配的 CNAME。等待 DNS/CDN 配置生效后，用
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
2. 撤销两个域名到 CDN 的 DNS change，或恢复上一条已知健康记录。回滚可以按域名单独
   执行：撤附件域名不影响安装与更新，反之亦然。
3. purge 两个域名；确认 consumer hostname 不再命中新配置。
4. 停止 CDN real-time log delivery，删除 response/request header rules、cache rules 与
   URL signing，再移除 accelerated domain。
5. 撤销该域名的 CDN private OSS access service role 授权。
6. 关闭两个 source bucket 的 logging；保留 `${LOG_BUCKET}` 到审计 retention 结束。
7. 删除 canary objects。仅当两个 content bucket 从未承载真实附件/发行制品且已确认
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
