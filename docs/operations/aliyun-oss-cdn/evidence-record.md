# 7. Evidence record

变更记录只保存：operator、UTC 时间、账号 ID 后四位、Region、两个 domain、两类 bucket ARN 的
脱敏标识、RAM policy/role ID、CDN config ID、SLS task ID、DNS change ID、验收报告 JSON
和 rollback target。不得保存：AccessKey、URL signing key、signed URL、完整 OSS endpoint、
原始 CDN/SLS 日志或 canary bytes。
