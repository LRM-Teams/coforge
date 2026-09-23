# 6. 上线前 acceptance gate

在各 bucket 写入随机、不可复用的 canary bytes：

- files：`acceptance/<nonce>/files.bin`；
- releases：`acceptance/<nonce>/release.bin`；
- releases：首次合法、已签名的 `/channels.json` bytes（不能用假 schema 覆盖已有对象）；
- images：`acceptance/<nonce>/image.png`——必须是**真实图片**，因为它要经过图片样式
  处理（profile image 域名上线时才需要，见[第 11 节](profile-image-domain.md)）。

分别计算本地 SHA-256。用 CDN console 为 files canary 和
`https://files.coforge.cn/acceptance/<nonce>/release.bin` 生成短时 signed URL；后者是
release object key 拿到附件域名上请求，带**有效签名**，专门验证它仍读不到 release
bucket——被拒的原因必须是缺少回源授权，而不是缺少签名。复制
[`oss-cdn-acceptance.example.json`](../oss-cdn-acceptance.example.json) 到仓库外权限为
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
