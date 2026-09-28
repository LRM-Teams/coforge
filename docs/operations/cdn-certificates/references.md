# 9. 官方依据

- [acme.sh dnsapi wiki — Ali (dns_ali)](https://github.com/acmesh-official/acme.sh/wiki/dnsapi)
- [acme.sh deployhooks wiki — Alibaba Cloud CDN (ali_cdn)](https://github.com/acmesh-official/acme.sh/wiki/deployhooks)
- [acme.sh dns_ali.sh source](https://github.com/acmesh-official/acme.sh/blob/master/dnsapi/dns_ali.sh) —
  确认它只调用 `AddDomainRecord`、`DeleteDomainRecord`、`DescribeDomainRecords`
- [acme.sh ali_cdn.sh source](https://github.com/acmesh-official/acme.sh/blob/master/deploy/ali_cdn.sh) —
  确认它只调用 `SetCdnDomainSSLCertificate`，并共享 `Ali_Key`/`Ali_Secret`
- [acme.sh How-to-install wiki](https://github.com/acmesh-official/acme.sh/wiki/How-to-install) —
  安装方式（git clone 或 curl \| sh）与自动写入的 crontab 任务
- [acme.sh README](https://github.com/acmesh-official/acme.sh) — 续期窗口
  （约每 30 天检查一次，ARI 优先）与 90 天证书有效期
- [Alibaba Cloud CDN — SetCdnDomainSSLCertificate](https://www.alibabacloud.com/help/en/cdn/developer-reference/api-cdn-2018-05-10-setcdndomainsslcertificate)
- [Alibaba Cloud DNS — AddDomainRecord](https://www.alibabacloud.com/help/en/dns/api-alidns-2015-01-09-adddomainrecord)
- [acme.sh Server wiki](https://github.com/acmesh-official/acme.sh/wiki/Server) —
  默认 CA 是 ZeroSSL，`--server letsencrypt` 才是 Let's Encrypt

**未能独立验证、本文不断言的点**：acme.sh 官方 wiki 页面本身没有明确写出
`dns_ali` 插件所需的最小 RAM 权限列表（wiki 只说「需要 RAM API key」）；[第 4
节](ram-permissions.md)的四个 action 是直接阅读 `dns_ali.sh`/`ali_cdn.sh` 源码里实际发出的 API
调用得到的，如果 acme.sh 后续版本改变了这两个脚本的实现，这张表可能需要
重新核对源码。另外，`DEPLOY_ALI_CDN_DOMAIN` 未设置时 `ali_cdn.sh` 会退回使用
证书的 CN 作为目标域名，本脚本选择始终显式设置它而不依赖这个默认值。
