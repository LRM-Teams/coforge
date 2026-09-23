# 1. 为什么 CDN 加速域名需要自己的证书

仓库 `AGENTS.md` 规定 Caddy 拥有 public TLS 与 edge
proxying，但那只覆盖 Caddy 直接反代的 `staging.coforge.cn`（以及未来的生产
`coforge.cn`）。三个 CDN 加速域名——`files-staging.coforge.cn`、
`releases-staging.coforge.cn`、`images-staging.coforge.cn`（及其生产对应
域名）——走的是完全不同的边缘：客户端 TLS 连接终止在阿里云 CDN 节点，Caddy
从未看到这条连接。Caddy 的自动 Let's Encrypt（内置 ACME 客户端）签发的证书只安装
在 Caddy 自己的进程里，对 CDN 边缘没有任何效果；CDN 必须有自己上传/绑定的证书,
通过 `SetCdnDomainSSLCertificate` API 配置，这与 Caddy 是两条完全独立的证书链。

因此本 runbook 与 [`aliyun-oss-cdn/`](../aliyun-oss-cdn/README.md)（bucket、origin、缓存、URL 签名）是互补
关系：那份文档的 [§5.3](../aliyun-oss-cdn/cdn-domains.md) 第 6 点提到「启用 HTTPS 证书后强制 HTTPS」，本文档就是
「证书从哪来、怎么保持有效」的实现细节。
