# 5. 配置加速域名

在 CDN console 分别添加精确域名 `files.coforge.cn`、`releases.coforge.cn` 与
`images.coforge.cn`，不要使用 wildcard。只有[第 1 节](prerequisites.md)的 ICP / 加速区域门禁对相应域名
满足后，才能继续上线和切 CNAME。

每个域名只有一个 origin，因此不配置 conditional origin、origin path rewrite 或
EdgeScript：域名边界本身就是 fail-closed 的，一个域名请求另一类对象只会因为该 object
不在它的 origin bucket 里而失败。

## 5.1 源站与回源 HOST

| 域名 | origin type | origin | 回源 HOST | 路径处理 |
| --- | --- | --- | --- | --- |
| `files.coforge.cn` | OSS | `${FILES_BUCKET}` | 该 bucket 域名 | 不 rewrite |
| `releases.coforge.cn` | OSS | `${RELEASES_BUCKET}` | 该 bucket 域名 | 不 rewrite |
| `images.coforge.cn` | OSS | `${IMAGES_BUCKET}` | 该 bucket 域名 | 不 rewrite |

不使用 Advanced Origin，不添加第二个 origin。任何一个域名出现第二个 origin 都视为配置
偏离，停止上线。

## 5.2 私有回源

对每个域名执行：

1. 在 Origin Fetch > Alibaba Cloud OSS Private Bucket Access 点击授权。
2. 选择 `Bucket in the Same Account`，启用 STS temporary token 模式。
3. 确认生成的 CDN service role 为 OSS read-only。该授权是账号级的，**不要**记录成
   「只对本域名的 origin bucket 生效」；真正的边界是本域名只配置了这一个 origin
   bucket，[第 6 节](acceptance-gate.md)的跨域名探针验证的正是这一点。
4. 禁止选择需要输入 bucket owner AK/SK 的 `Across Accounts` 模式。
5. 不把 OSS presigned query 作为 CDN origin URL；client CDN signing 与 origin STS 是
   两条独立认证链。

## 5.3 URL signing、cache 与 headers

1. 只为 `files.coforge.cn` 启用 CDN URL signing，作用于整个域名而不是某条规则条件；
   建议 Type A，并让 backend Secret 与 CDN primary/secondary key、`${FILES_URL_TTL}`
   完全一致。验收阶段使用 console Signed URL Generator，key 不写入 acceptance JSON、
   shell history 或日志。
2. `releases.coforge.cn` 与 `images.coforge.cn` 不启用 client URL signing。release 的
   公开性由 artifact signature/digest 验证承担；profile image 的访问控制是不可枚举的
   object key 本身。两者 OSS origin 仍保持 private。
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

## 5.4 访问日志

1. 为每个域名分别激活 CDN Real-Time Log Delivery，选择 `${SLS_PROJECT}` /
   `${SLS_LOGSTORE}` 和经批准 retention（初始建议 7 天）。
2. 确认各 delivery 状态均为 `Succeeded`，并能按 domain 维度分别查询。
3. SLS 日志可能含短时 URL signing 参数，应按 credential-equivalent 数据限制读取；
   Issue/PR 只保存脱敏计数和 request ID，不粘贴原始 URI。
