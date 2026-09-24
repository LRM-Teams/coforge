# 3. 涵盖的域名

与 [`scripts/ops/renew-cdn-certificates.sh`](../../../scripts/ops/renew-cdn-certificates.sh)
顶部的 `CDN_DOMAINS` 数组必须保持一致（`scripts/ops/cdn-certificates.test.ts`
会校验两者不漂移）：

| 域名 | 现状 | 原证书 |
| --- | --- | --- |
| `files-staging.coforge.cn` | 已上线，HTTPS 已启用 | `cert-d7orsd`，2026-12-02 到期 |
| `releases-staging.coforge.cn` | 已上线，HTTPS 已启用 | `cert-a4kn7`，2026-12-03 到期 |
| `images-staging.coforge.cn` | 2026-09-20 新建，HTTPS 已启用但**无证书** | 无 |

新增生产域名（`files.coforge.cn`、`releases.coforge.cn`、`images.coforge.cn`）
时，只需要在脚本的 `CDN_DOMAINS` 数组里加一行，并在这张表里同步加一行。
