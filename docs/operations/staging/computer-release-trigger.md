# 触发 Computer 本地分发发布

云应用走 push-to-main 自动部署，但本地 Computer/Daemon 发布是手动的（见
[`docs/release/local-distribution.md`](../../release/local-distribution.md)）：只挂
`workflow_dispatch`，不挂 `on: push`。触发一次 staging 发布：

```sh
gh workflow run release-staging.yml --repo LRM-Teams/coforge
# 或指定版本号，不填则自动生成 0.0.0-dev.<run_number>-<short sha>
gh workflow run release-staging.yml --repo LRM-Teams/coforge -f version=0.2.0-rc.1
```

**已发布的版本不可覆盖。** 发布前脚本会先探测 `<version>/manifest.json`，已存在就直接
报错退出——CDN 对 `<version>/*` 缓存 365 天，重发同一个版本号会让不同边缘节点长期返回
不同的字节。所以：
- 想重发内容，请换一个版本号（`-f version=...`），不要覆盖旧的；
- 对**成功**的 run 执行 `gh run rerun` 会被这条守卫拦下，这是预期行为；
- 对在 `gates` 阶段失败（比如撞上 flaky 测试）的 run 执行 `gh run rerun` 是安全的：
  那次 run 从没走到发布，manifest 不存在；
- 上传到一半失败也可以直接重跑同一个版本号：manifest 是最后一个上传的对象，
  半截的发布不会留下它。

workflow 用 GitHub OIDC 换取阿里云 RAM 角色 `coforge-release-publisher` 的临时 STS
凭据（`ALIBABA_CLOUD_ROLE_ARN` / `ALIBABA_CLOUD_OIDC_PROVIDER_ARN`，见
`.github/workflows/release-staging.yml`）——该角色的信任策略只认
`repo:LRM-Teams@289986103/coforge@1345850229:environment:staging`，没有长期 AccessKey，也就不需要在这张表
里放对应的 secret，跑 `scripts/release/publish.ts` 把 Computer/Daemon 发布到
`coforge-releases-staging` bucket（`https://releases-staging.coforge.cn`），
默认只编译四个 POSIX target（不含 Windows，见该脚本的注释）。用
`gh run watch` 或仓库 Actions 页面看进度；发布记录留在 workflow run 里，不写入本
文档。
