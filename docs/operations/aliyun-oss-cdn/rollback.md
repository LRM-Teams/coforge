# 8. 回滚与删除

按以下逆序执行，任一步失败就停止并保留当前 evidence：

1. 把 backend delivery adapter 保持/切回 Direct OSS；旧 CDN signed URL 至少保留到
   `${FILES_URL_TTL}` 结束。
2. 撤销相关域名到 CDN 的 DNS change，或恢复上一条已知健康记录。回滚可以按域名单独
   执行：撤附件域名不影响安装与更新，反之亦然；撤 image 域名前先取消 Web 的
   `COFORGE_IMAGE_DELIVERY_URL` 与 `COFORGE_IMAGE_OSS_BUCKET`，头像随即回到已认证路由。
3. purge 相关域名；确认 consumer hostname 不再命中新配置。
4. 停止 CDN real-time log delivery，删除 response/request header rules、cache rules 与
   URL signing，再移除 accelerated domain。
5. 撤销该域名的 CDN private OSS access service role 授权。
6. 关闭各 source bucket 的 logging；保留 `${LOG_BUCKET}` 到审计 retention 结束。
7. 删除 canary objects。仅当相关 content bucket 从未承载真实附件/发行制品且已确认
   empty 时，临时加入 `oss:DeleteBucket` 并删除 bucket；否则不删数据，只撤流量与权限。
8. 撤销并删除 `${OPERATOR}`。记录 healthy rollback 或 failed rollback，不用“资源看起来
   已消失”替代验证。
