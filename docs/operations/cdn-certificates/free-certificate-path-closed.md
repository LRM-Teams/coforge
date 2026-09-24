# 2. 为什么免费证书路径已经走不通

2026-02-24 起，阿里云把 SSL 证书迁移到付费订阅模式；「个人测试证书 /
非订阅模式」免费证书的新签发额度已经归零，控制台里过期后无法像过去一样直接
重新申请。[`aliyun-oss-cdn/` §10](../aliyun-oss-cdn/staging-record.md) 记录的 `cert-d7orsd`
（`files-staging.coforge.cn`，2026-12-02 到期）与 `cert-a4kn7`
（`releases-staging.coforge.cn`，2026-12-03 到期）都是那条已关闭路径下签发的
最后一批证书；`images-staging.coforge.cn` 是 2026-09-20 新建的加速域名，HTTPS
已开启但从未配置证书，同样受影响，且需求上就没有免费证书可用。

Frank 的决定（2026-09-20）：采用行业标准做法——[acme.sh](https://github.com/acmesh-official/acme.sh)
通过 DNS-01 校验（阿里云 DNS API，插件 `dns_ali`）签发 Let's Encrypt 证书，用
`ali_cdn` 部署钩子自动推送到 CDN，续期完全自动、免费、永久。不再依赖阿里云的
免费证书配额或人工操作控制台。
