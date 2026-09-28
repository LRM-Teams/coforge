# 11. Profile image 域名（尚未 provision）

头像与项目图标是第三个内容类：匿名、不签名、永不过期的 URL，访问控制是不可枚举的
object key 本身。这一节是它
在 staging 与生产的执行清单；前面各节的通用要求（private bucket、Block Public Access、
单一 origin、Cookie 删除、HTTPS、日志）同样适用，不在此重复。

为什么必须是独立 bucket：阿里云私有回源授权无法限制到 bucket 内的部分对象，URL 鉴权
又是按域名的开关。只要一个不签名的域名指向附件 bucket，附件就从「必须签名」降级成
「知道 key 即可下载」。Slack 的做法同样是两套域名（`avatars.slack-edge.com` 与
`files.slack.com`）；Discord 用同一个 `cdn.discordapp.com` 按路径区分，那是自研边缘才
有的能力，阿里云 CDN 给不了。

执行顺序：

1. 按[第 4 节](oss-origins.md)创建 `${IMAGES_BUCKET}`（同账号、同 Region、`private`、Block Public
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
4. 按[第 5 节](cdn-domains.md)添加域名：staging 是 `images-staging.coforge.cn` 回源
   `coforge-images-staging`，生产是 `images.coforge.cn` 回源生产 `${IMAGES_BUCKET}`。单一 origin
   指向 `${IMAGES_BUCKET}`，开启同账号 STS 私有回源，**不启用** URL 鉴权，缓存与响应头
   按 [5.3](cdn-domains.md) 表格的 `images` 行设置为 `public, max-age=31536000, immutable`。
   `images-staging.coforge.cn` 的 HTTPS 证书不走控制台手动上传：它已经是
   [`cdn-certificates/`](../cdn-certificates/README.md) 里 `scripts/ops/renew-cdn-certificates.sh`
   覆盖的三个域名之一，按该文档[第 5 节](../cdn-certificates/first-run.md)跑一次首次签发即可，之后自动续期。
5. 在该域名的性能优化里把「忽略参数」改成**保留指定参数**并保留 `x-oss-process`。
   CDN 默认过滤 `?` 之后的全部参数，不改这一项样式参数根本到不了 OSS：结果不是报错，
   而是静默回退成原图，慢但能显示——所以必须按[第 6 节](acceptance-gate.md)实测样式 URL 的响应大小。
6. 开启 bucket 的**原图保护**，使匿名请求只能通过具名样式访问，任意
   `x-oss-process` 表达式被拒；记录它在 CDN 私有回源（回源请求自带签名）下的实际
   行为，因为原图保护官方说明「仅对匿名访问有效，带签名访问无效」，这条对经 CDN 的
   请求是否成立必须实测确认，不能照抄推断。
7. 配置带宽封顶与流量告警。这个域名没有签名可作速率约束；若上一步的原图保护在 CDN
   路径上不生效，封顶就是唯一的滥用上界。
8. 按[第 6 节](acceptance-gate.md)跑 acceptance gate，`image` 探针与两条新的跨域名探针必须 PASS，然后切
   CNAME 并用 consumer hostname 重跑。验收输入里三个域名必须同属一个环境——三个都是
   `*-staging.coforge.cn` 或三个都是生产域名，混用会被 `input_contract` 直接拒绝，
   免得用 staging 的 image 域名去"证明"生产附件域名的边界。
9. 全部 PASS 后才在 Web 的 compose 里同时启用 `COFORGE_IMAGE_OSS_BUCKET` 与
   `COFORGE_IMAGE_DELIVERY_URL`（两者必须同时设置，只设 URL 会在启动时直接失败）。
   部署后 `curl -sI https://<web>/health | grep -i x-coforge-image-delivery` 应为
   `configured`，页面上的头像 URL 应指向 image 域名。

回滚：取消这两个环境变量即可，下一次响应起头像回到已认证路由；已经发出去的 image URL
在域名删除前仍然可读。
