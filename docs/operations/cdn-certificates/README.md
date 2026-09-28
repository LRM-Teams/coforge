# CDN 证书 runbook：Let's Encrypt + acme.sh 自动续期

状态：**2026-09-20 新建**，替代 [`aliyun-oss-cdn/`](../aliyun-oss-cdn/README.md) [第 10 节](../aliyun-oss-cdn/staging-record.md)里
「两张免费证书不自动续期，到期需要人工重新签发」的旧结论。本文是证书生命周期
（签发、部署、续期、验证、回滚）的唯一权威来源；第 10 节现在只指向本文。

## 目录

- [1. 为什么 CDN 加速域名需要自己的证书](why-own-certificates.md): 为什么 CDN 加速域名需要独立于 Caddy 的证书。
- [2. 为什么免费证书路径已经走不通](free-certificate-path-closed.md): 阿里云免费证书路径关闭，以及改用 acme.sh + Let's Encrypt 的决定。
- [3. 涵盖的域名](domains.md): 续期脚本涵盖的域名清单。
- [4. RAM 权限：AccessKey 需要哪些 action](ram-permissions.md): AccessKey 需要的最小 RAM action 与资源收窄。
- [5. 首次执行：operator 必须亲自做的事](first-run.md): 首次执行时 operator 必须亲自做的事。
- [6. 续期如何工作（首次运行之后不需要再手动做任何事）](renewal.md): 首次运行后续期如何自动工作：cron、签发与部署钩子。
- [7. 如何验证](verification.md): 如何验证 CDN 边缘当前的证书与到期时间。
- [8. 回滚：换回手动上传的证书](rollback.md): 回滚到手动上传证书。
- [9. 官方依据](references.md): 官方依据与未能独立验证的点。
