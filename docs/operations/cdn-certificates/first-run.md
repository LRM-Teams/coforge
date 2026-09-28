# 5. 首次执行：operator 必须亲自做的事

以下步骤只有 Frank 或其明确授权的阿里云 operator 能做，Agent 不能代为创建
AccessKey：

1. 在 RAM 创建一个专用的 console user（例如 `cdn-cert-renewal`），不需要登录
   控制台权限，只需要能创建 AccessKey。
2. 按[第 4 节](ram-permissions.md)的四个 action 和两条 ARN 附加一条自定义 Policy；不要选择系统
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

   首次运行会：安装 acme.sh（若尚未安装，见[第 6 节](renewal.md)）、为三个域名各签发一张
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
