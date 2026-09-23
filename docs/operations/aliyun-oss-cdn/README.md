# 阿里云 OSS/CDN provisioning runbook

状态：**staging 两个域名已上线**（见[第 10 节](staging-record.md)的实际记录）；生产的
`files.coforge.cn` 与 `releases.coforge.cn` 仍待 operator 执行，尚不可按本文视为已上线。
profile image 域名 `images.coforge.cn`（及 staging 对应域名）staging 与生产都**尚未
provision**，[第 11 节](profile-image-domain.md)是它的执行清单。
backend OSS adapter 已实现（`apps/web/src/server/files/oss-file-storage.server.ts`，
由 `COFORGE_FILE_STORAGE=oss` 启用）；浏览器直传（PostObject policy）与 CDN
URL-signed 下载仍是后续步骤，尚未实现。

适用范围：三个 private content bucket、三个加速域名 `files.coforge.cn`、
`releases.coforge.cn` 与 `images.coforge.cn`、最小权限 RAM、访问日志、验收与回滚

profile image 域名（头像与项目图标）
是第三个 trust zone，staging 与生产都尚未 provision；[第 11 节](profile-image-domain.md)是它的专用步骤，其余各节
的通用要求同样适用。

本文把 [`release.md`](../../release.md) 与仓库 `AGENTS.md` 已批准的边界转换为 operator 步骤，不改变应用授权或
发行协议。所有 `${...}` 均为执行时参数，不能原样提交到控制台。

## 目录

- [1. 开始前的硬门禁](prerequisites.md): 开始前必须由 Frank 或授权 operator 填写的参数与凭据门禁。
- [2. 目标拓扑与对象映射](topology.md): 三个域名、三个 trust zone 的目标拓扑与 object key 映射。
- [3. 建立最小权限身份](ram-identity.md): provisioning 用的最小权限 RAM 身份与 action/resource 收窄。
- [4. 创建 private OSS origins 与日志](oss-origins.md): 创建 private OSS origin bucket、访问日志与允许的 object key。
- [5. 配置加速域名](cdn-domains.md): 配置加速域名：源站与回源 HOST、私有回源、URL signing、缓存、headers 与访问日志。
- [6. 上线前 acceptance gate](acceptance-gate.md): 上线前 acceptance gate：canary、行为探针与必需的配置证据。
- [7. Evidence record](evidence-record.md): 变更记录里保存与不得保存的内容。
- [8. 回滚与删除](rollback.md): 按逆序回滚与删除的步骤。
- [9. 官方依据](references.md): 阿里云官方依据链接。
- [10. Staging 实际配置记录（2026-09-04）](staging-record.md): Staging 已执行并验证的实际配置记录（2026-09-04 起）。
- [11. Profile image 域名（尚未 provision）](profile-image-domain.md): Profile image 域名（头像与项目图标）的专用执行清单与回滚。
