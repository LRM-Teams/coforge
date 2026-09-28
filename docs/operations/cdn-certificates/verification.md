# 7. 如何验证

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
