# 4. RAM 权限：AccessKey 需要哪些 action

`dns_ali`（DNS-01 校验）与 `ali_cdn`（证书部署）共用同一对
`Ali_Key`/`Ali_Secret` 环境变量，对应同一个 RAM AccessKey。这个 AccessKey**只**
需要下列 action，不需要 `AliyunDNSFullAccess`、`AliyunCDNFullAccess` 或任何
`*:*`：

| 用途 | Action | 来源 |
| --- | --- | --- |
| 写入 DNS-01 校验用的 TXT 记录 | `alidns:AddDomainRecord` | [AddDomainRecord](https://www.alibabacloud.com/help/en/dns/api-alidns-2015-01-09-adddomainrecord) |
| 校验完成后删除该 TXT 记录 | `alidns:DeleteDomainRecord` | acme.sh `dns_ali.sh` 校验流程的一部分（见[第 9 节](references.md)） |
| 轮询记录是否已生效 | `alidns:DescribeDomainRecords` | 同上 |
| 把证书推送到 CDN 加速域名 | `cdn:SetCdnDomainSSLCertificate` | [SetCdnDomainSSLCertificate](https://www.alibabacloud.com/help/en/cdn/developer-reference/api-cdn-2018-05-10-setcdndomainsslcertificate) |

这四个 action 是从 acme.sh 官方 `dns_ali.sh`（DNS 插件）与 `ali_cdn.sh`
（部署钩子）源码里实际发出的 API 调用逐一核对出来的，不是从 acme.sh 文档的
文字描述推断的——两份脚本各自只调用这几个 Action，没有更多。

资源收窄到 `coforge.cn`（DNS 记录）与具体 CDN 域名两条 ARN，仿照
[`aliyun-oss-cdn/` §3](../aliyun-oss-cdn/ram-identity.md) 的收窄方式：

- `acs:alidns:*:${ACCOUNT_ID}:domain/coforge.cn`
- `acs:cdn:*:${ACCOUNT_ID}:domain/files-staging.coforge.cn`、
  `.../domain/releases-staging.coforge.cn`、
  `.../domain/images-staging.coforge.cn`（生产域名上线后各加一条）

不要附加 `oss:*`、`ram:*` 或其他 bucket/CDN 域名以外的权限；这个 AccessKey 与
[`aliyun-oss-cdn/`](../aliyun-oss-cdn/README.md) 里 provisioning 用的 `${OPERATOR}` 是两个独立身份，互不
复用。
