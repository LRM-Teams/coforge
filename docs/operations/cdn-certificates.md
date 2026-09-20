# CDN 证书 runbook：Let's Encrypt + acme.sh 自动续期

状态：**2026-09-20 新建**，替代 [`aliyun-oss-cdn.md`](aliyun-oss-cdn.md) 第 10 节里
「两张免费证书不自动续期，到期需要人工重新签发」的旧结论。本文是证书生命周期
（签发、部署、续期、验证、回滚）的唯一权威来源；第 10 节现在只指向本文。

## 1. 为什么 CDN 加速域名需要自己的证书

[`architecture.md`](../architecture.md) 里 Caddy 拥有 public TLS 与 edge
proxying，但那只覆盖 Caddy 直接反代的 `staging.coforge.cn`（以及未来的生产
`coforge.cn`）。三个 CDN 加速域名——`files-staging.coforge.cn`、
`releases-staging.coforge.cn`、`images-staging.coforge.cn`（及其生产对应
域名）——走的是完全不同的边缘：客户端 TLS 连接终止在阿里云 CDN 节点，Caddy
从未看到这条连接。Caddy 的自动 Let's Encrypt（内置 ACME 客户端）签发的证书只安装
在 Caddy 自己的进程里，对 CDN 边缘没有任何效果；CDN 必须有自己上传/绑定的证书,
通过 `SetCdnDomainSSLCertificate` API 配置，这与 Caddy 是两条完全独立的证书链。

因此本 runbook 与 `aliyun-oss-cdn.md`（bucket、origin、缓存、URL 签名）是互补
关系：那份文档的 §5.3 第 6 点提到「启用 HTTPS 证书后强制 HTTPS」，本文档就是
「证书从哪来、怎么保持有效」的实现细节。

## 2. 为什么免费证书路径已经走不通

2026-02-24 起，阿里云把 SSL 证书迁移到付费订阅模式；「个人测试证书 /
非订阅模式」免费证书的新签发额度已经归零，控制台里过期后无法像过去一样直接
重新申请。`aliyun-oss-cdn.md` §10 记录的 `cert-d7orsd`
（`files-staging.coforge.cn`，2026-12-02 到期）与 `cert-a4kn7`
（`releases-staging.coforge.cn`，2026-12-03 到期）都是那条已关闭路径下签发的
最后一批证书；`images-staging.coforge.cn` 是 2026-09-20 新建的加速域名，HTTPS
已开启但从未配置证书，同样受影响，且需求上就没有免费证书可用。

Frank 的决定（2026-09-20）：采用行业标准做法——[acme.sh](https://github.com/acmesh-official/acme.sh)
通过 DNS-01 校验（阿里云 DNS API，插件 `dns_ali`）签发 Let's Encrypt 证书，用
`ali_cdn` 部署钩子自动推送到 CDN，续期完全自动、免费、永久。不再依赖阿里云的
免费证书配额或人工操作控制台。

## 3. 涵盖的域名

与 [`scripts/ops/renew-cdn-certificates.sh`](../../scripts/ops/renew-cdn-certificates.sh)
顶部的 `CDN_DOMAINS` 数组必须保持一致（`scripts/ops/cdn-certificates.test.ts`
会校验两者不漂移）：

| 域名 | 现状 | 原证书 |
| --- | --- | --- |
| `files-staging.coforge.cn` | 已上线，HTTPS 已启用 | `cert-d7orsd`，2026-12-02 到期 |
| `releases-staging.coforge.cn` | 已上线，HTTPS 已启用 | `cert-a4kn7`，2026-12-03 到期 |
| `images-staging.coforge.cn` | 2026-09-20 新建，HTTPS 已启用但**无证书** | 无 |

新增生产域名（`files.coforge.cn`、`releases.coforge.cn`、`images.coforge.cn`）
时，只需要在脚本的 `CDN_DOMAINS` 数组里加一行，并在这张表里同步加一行。

## 4. RAM 权限：AccessKey 需要哪些 action

`dns_ali`（DNS-01 校验）与 `ali_cdn`（证书部署）共用同一对
`Ali_Key`/`Ali_Secret` 环境变量，对应同一个 RAM AccessKey。这个 AccessKey**只**
需要下列 action，不需要 `AliyunDNSFullAccess`、`AliyunCDNFullAccess` 或任何
`*:*`：

| 用途 | Action | 来源 |
| --- | --- | --- |
| 写入 DNS-01 校验用的 TXT 记录 | `alidns:AddDomainRecord` | [AddDomainRecord](https://www.alibabacloud.com/help/en/dns/api-alidns-2015-01-09-adddomainrecord) |
| 校验完成后删除该 TXT 记录 | `alidns:DeleteDomainRecord` | acme.sh `dns_ali.sh` 校验流程的一部分（见第 9 节） |
| 轮询记录是否已生效 | `alidns:DescribeDomainRecords` | 同上 |
| 把证书推送到 CDN 加速域名 | `cdn:SetCdnDomainSSLCertificate` | [SetCdnDomainSSLCertificate](https://www.alibabacloud.com/help/en/cdn/developer-reference/api-cdn-2018-05-10-setcdndomainsslcertificate) |

这四个 action 是从 acme.sh 官方 `dns_ali.sh`（DNS 插件）与 `ali_cdn.sh`
（部署钩子）源码里实际发出的 API 调用逐一核对出来的，不是从 acme.sh 文档的
文字描述推断的——两份脚本各自只调用这几个 Action，没有更多。

资源收窄到 `coforge.cn`（DNS 记录）与具体 CDN 域名两条 ARN，仿照
`aliyun-oss-cdn.md` §3 的收窄方式：

- `acs:alidns:*:${ACCOUNT_ID}:domain/coforge.cn`
- `acs:cdn:*:${ACCOUNT_ID}:domain/files-staging.coforge.cn`、
  `.../domain/releases-staging.coforge.cn`、
  `.../domain/images-staging.coforge.cn`（生产域名上线后各加一条）

不要附加 `oss:*`、`ram:*` 或其他 bucket/CDN 域名以外的权限；这个 AccessKey 与
`aliyun-oss-cdn.md` 里 provisioning 用的 `${OPERATOR}` 是两个独立身份，互不
复用。

## 5. 首次执行：operator 必须亲自做的事

以下步骤只有 Frank 或其明确授权的阿里云 operator 能做，Agent 不能代为创建
AccessKey：

1. 在 RAM 创建一个专用的 console user（例如 `cdn-cert-renewal`），不需要登录
   控制台权限，只需要能创建 AccessKey。
2. 按第 4 节的四个 action 和两条 ARN 附加一条自定义 Policy；不要选择系统
   预置的 FullAccess 策略。
3. 为该 user 创建一对 AccessKey（`Ali_Key` / `Ali_Secret`），只记录 AccessKey
   ID 的后四位到变更记录，完整的 AccessKey Secret 不进入 Issue、PR、聊天记录
   或本仓库的任何文件。
4. 在将要运行本脚本的机器上（运维跳板机或将来的专用续期主机；不是 CI，因为
   CI 不持有长期凭据也不该持有）执行：

   ```bash
   export Ali_Key="<第 3 步创建的 AccessKey ID>"
   export Ali_Secret="<第 3 步创建的 AccessKey Secret>"
   scripts/ops/renew-cdn-certificates.sh
   ```

   首次运行会：安装 acme.sh（若尚未安装，见第 6 节）、为三个域名各签发一张
   Let's Encrypt 证书、把证书部署到对应 CDN 域名、检查 acme.sh 的 cron 是否
   存在、最后打印每个域名当前观测到的证书到期时间。

5. 确认打印出的三个 `notAfter` 都是新签发的 Let's Encrypt 证书（约 90 天后
   到期），而不是旧的 `cert-d7orsd`/`cert-a4kn7`。
6. 在变更记录里保存：执行时间、执行人、三个域名各自的新到期时间、Alibaba
   Cloud 证书 ID（CDN 控制台里能看到 acme.sh 新建的证书条目）。不要保存
   AccessKey 或私钥内容。
7. 撤销临时排障用的任何长期凭据；`Ali_Key`/`Ali_Secret` 长期保留在运行本脚本
   的机器上属于设计的一部分（续期需要它们），但要确保这台机器不是共享的开发
   机，且 `~/.acme.sh/account.conf`（acme.sh 存放这两个变量和证书私钥的地方）
   权限收紧到运维账号自己可读。

## 6. 续期如何工作（首次运行之后不需要再手动做任何事）

`scripts/ops/renew-cdn-certificates.sh` 本身**不是**续期的调度者：

1. 如果 `~/.acme.sh/acme.sh` 不存在，脚本会从 acme.sh 官方仓库
   `git clone` 后执行 `./acme.sh --install`（这是 acme.sh 自己文档里的两种
   官方安装方式之一，另一种是 `curl | sh`；选择 git clone 是因为它可以审查
   源码、可以钉在某个 tag 上，见脚本里的 `ACME_GIT_REF`）。这一步会在当前
   用户的 crontab 里写入一条每天执行的任务：

   ```
   0 0 * * * "$HOME/.acme.sh"/acme.sh --cron --home "$HOME/.acme.sh" > /dev/null
   ```

   这是 acme.sh 唯一的调度者；本脚本每次运行只用 `crontab -l` 确认这条任务
   还在，不会再装第二个 cron 或 systemd timer。如果它不见了，脚本会打印
   `acme.sh --install-cronjob` 这条可以直接执行的修复命令。
2. `acme.sh --issue --server letsencrypt --dns dns_ali -d <domain>` 对每个域名
   执行一次。`--server letsencrypt` 是显式写死的：acme.sh 自己的默认 CA 是
   **ZeroSSL** 而不是 Let's Encrypt（见
   [Server 说明](https://github.com/acmesh-official/acme.sh/wiki/Server)），
   不写这一项就会按执行主机上碰巧的默认值签发，和本文档承诺的 CA 不一致。根据
   acme.sh 官方说明，证书默认每 30 天检查一次续期（有 ACME Renewal
   Information 时以 CA 建议的窗口为准），Let's Encrypt 证书有效期 90 天，
   所以实际续期发生在到期前约 60 天，留有充足的重试窗口。已经签发且未到续期
   窗口的证书会被跳过（除非 `FORCE_RENEW=1`），这就是脚本可以反复安全运行的
   原因。
3. `acme.sh --deploy -d <domain> --deploy-hook ali_cdn` 只需要成功执行一次：
   acme.sh 会把这个部署钩子连同 `DEPLOY_ALI_CDN_DOMAIN` 一起写进该域名自己的
   配置文件里；官方文档确认这类部署配置「will be stored with the domain
   configuration and will be available when renewing, so that deploy will
   happen automatically when renewed」。也就是说，第 5 节的首次运行之后，
   之后每一次由 cron 触发的续期都会自动重新调用 `ali_cdn`，把新证书推送到
   CDN，不需要人再跑一次这个脚本——除非要检查/记录续期是否成功，或者
   `crontab -l` 显示 cron 任务丢失需要人工介入。

## 7. 如何验证

按需随时重新运行 `scripts/ops/renew-cdn-certificates.sh`（不需要凭据以外的
参数）。它每次都会在末尾打印一段独立于 acme.sh 内部状态的现场证据：

```
--- observed CDN certificate expiry ---
files-staging.coforge.cn: notAfter=Dec 19 23:59:59 2026 GMT
releases-staging.coforge.cn: notAfter=Dec 19 23:59:59 2026 GMT
images-staging.coforge.cn: notAfter=Dec 19 23:59:59 2026 GMT
```

这一段是脚本自己对 `openssl s_client -servername <domain> -connect
<domain>:443` 现场结果调用 `openssl x509 -noout -enddate` 得到的，也可以手动
复现，不依赖脚本：

```bash
echo | openssl s_client -servername files-staging.coforge.cn \
  -connect files-staging.coforge.cn:443 2>/dev/null \
  | openssl x509 -noout -enddate -issuer
```

`-issuer` 应显示 `Let's Encrypt`，而不是阿里云证书服务颁发的证书。也可以在
CDN 控制台的域名详情页确认证书来源与到期时间，作为交叉验证。

## 8. 回滚：换回手动上传的证书

如果 acme.sh 自动化出现问题（例如 DNS API 权限被收回、CDN 侧证书槽位被别的
流程覆盖），可以回退到手动上传证书的旧路径，不影响其余配置：

1. 在 CDN 控制台为受影响域名的「HTTPS 证书」重新手动上传一张证书（购买的
   付费证书，或者用本仓库外的 `acme.sh --issue --dns dns_ali -d <domain>` 单独
   跑出来的证书文件，手动执行一次 `SetCdnDomainSSLCertificate`），跳过
   `ali_cdn` 自动部署这一步。
2. 如果要临时停止 acme.sh 对该域名的自动续期/部署，用
   `acme.sh --remove -d <domain>` 移除它的证书配置（不会撤销已经签发的
   证书，只是不再自动续期/部署），并在这份文档里记录哪些域名处于手动模式、
   为什么、以及计划何时切回自动化。
3. 不需要撤销 `Ali_Key`/`Ali_Secret` 本身，除非怀疑凭据泄露；回滚到手动证书
   之后这对凭据只是暂时不再被使用。

## 9. 官方依据

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
`dns_ali` 插件所需的最小 RAM 权限列表（wiki 只说「需要 RAM API key」）；第 4
节的四个 action 是直接阅读 `dns_ali.sh`/`ali_cdn.sh` 源码里实际发出的 API
调用得到的，如果 acme.sh 后续版本改变了这两个脚本的实现，这张表可能需要
重新核对源码。另外，`DEPLOY_ALI_CDN_DOMAIN` 未设置时 `ali_cdn.sh` 会退回使用
证书的 CN 作为目标域名，本脚本选择始终显式设置它而不依赖这个默认值。
