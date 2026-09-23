# 4. 创建 private OSS origins 与日志

对 `${FILES_BUCKET}`、`${RELEASES_BUCKET}`、`${IMAGES_BUCKET}` 分别执行：

1. 在 `${REGION}` 创建 Standard bucket，ACL 选择 `private`。
2. 保持 Block Public Access 开启；不得添加 anonymous principal、`public-read`、
   `public-read-write`、static website hosting 或 object-level public ACL。
3. 记录 bucket ARN、Region、ACL 与 Block Public Access 状态。不要在 Issue、PR 或公开
   日志中记录 endpoint。
4. 在 Logging > Logging 开启 OSS access logging，目标选择同账号同 Region 的
   `${LOG_BUCKET}`：附件使用 `oss/files/` prefix，发行使用 `oss/releases/` prefix，
   profile image 使用 `oss/images/` prefix。
   `${LOG_BUCKET}` 自身保持 private、Block Public Access，并配置经批准的 lifecycle；
   不把 source bucket 自己设为 log sink，避免日志递归。

私有用户文件 bucket 只允许 canonical key
`workspaces/{workspace_id}/attachments/{attachment_id}/original`；profile image bucket
只允许 `users/{user_id}/avatars/{avatar_id}/original` 与
`workspaces/{workspace_id}/projects/{project_id}/icons/{icon_id}/original`；发行 bucket 只允许
[`release.md`](../../release.md) 定义的 immutable trees、`channels.json` 与 installer
入口。[第 6 节](acceptance-gate.md)的随机 `acceptance/` canary 是上线前唯一临时例外，验收后必须删除；不要
提前创建目录占位对象。
