# 3. 建立最小权限身份

1. Frank 在 RAM 创建 console-only user `${OPERATOR}`，强制 MFA，不创建 AccessKey。
2. 只授予本次变更需要的 action；禁止附加 `AliyunOSSFullAccess`、
   `AliyunCDNFullAccess` 或 `ram:*`。
3. bucket 创建阶段只有 `oss:PutBucket` 与 `oss:PutBucketAcl` 可以使用
   `acs:oss:*:${ACCOUNT_ID}:*`。两个名字创建成功后立即把 resource 收窄为：
   `acs:oss:*:${ACCOUNT_ID}:${FILES_BUCKET}`、
   `acs:oss:*:${ACCOUNT_ID}:${FILES_BUCKET}/*`、
   `${RELEASES_BUCKET}` 对应两项，以及 `${LOG_BUCKET}` 的日志写入 prefix。
4. 收窄后的 OSS action 仅保留：`oss:GetBucketInfo`、
   `oss:GetBucketLocation`、`oss:GetBucketAcl`、`oss:PutBucketAcl`、
   `oss:GetBucketLogging`、`oss:PutBucketLogging`、
   `oss:DeleteBucketLogging`、canary 所需的 `oss:PutObject`、
   `oss:GetObject`、`oss:DeleteObject` 和 `oss:ListObjects`。`oss:DeleteBucket` 仅在
   rollback 窗口临时加入。
5. CDN action 按 domain ARN
   `acs:cdn:*:${ACCOUNT_ID}:domain/files.coforge.cn` 与
   `acs:cdn:*:${ACCOUNT_ID}:domain/releases.coforge.cn` 收窄：
   `cdn:AddCdnDomain`、`cdn:DescribeCdnUserDomains`、
   `cdn:DescribeCdnDomainDetail`、`cdn:BatchSetCdnDomainConfig`、
   `cdn:DescribeCdnDomainConfigs`、`cdn:BatchDeleteCdnDomainConfig`、
   `cdn:SetCdnDomainCSRCertificate`、`cdn:RefreshObjectCaches`、
   `cdn:DescribeRefreshTasks`、`cdn:CreateRealTimeLogDelivery` 与
   `cdn:DescribeDomainRealtimeLogDelivery`。某个 action 的官方授权表若标记为
   `All Resources`，只对该 action 使用 `*`，不要扩大同 statement 的其他 action。
6. CDN private-origin 与 real-time-log service roles 由 Frank 在服务授权页面确认创建；
   不给 `${OPERATOR}` RAM 管理权限。完成后记录 role/policy 名和 ARN，不记录 credential。
7. 验收完成后撤销 `${OPERATOR}` 的变更权限并删除该临时 user。后续 release publisher、
   attachment upload signer 和 backend download signer 分别使用独立 role；不能复用
   provisioner 身份。
