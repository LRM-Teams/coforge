# 6. 续期如何工作（首次运行之后不需要再手动做任何事）

`scripts/ops/renew-cdn-certificates.sh` 本身**不是**续期的调度者：

1. 如果 `~/.acme.sh/acme.sh` 不存在，脚本会从 acme.sh 官方仓库
   `git clone` 后执行 `./acme.sh --install`（这是 acme.sh 自己文档里的两种
   官方安装方式之一，另一种是 `curl | sh`；选择 git clone 是因为它可以审查
   源码、可以钉在某个 tag 上，见脚本里的 `ACME_GIT_REF`）。这一步会在当前
   用户的 crontab 里写入一条每天执行的任务：

   ```
   0 0 * * * "$HOME/.acme.sh"/acme.sh --cron --home "$HOME/.acme.sh" > /dev/null
   ```

   这是 acme.sh 唯一的调度者；本脚本每次运行只用 `crontab -l` 确认这条任务
   还在，不会再装第二个 cron 或 systemd timer。如果它不见了，脚本会打印
   `acme.sh --install-cronjob` 这条可以直接执行的修复命令。
2. `acme.sh --issue --server letsencrypt --dns dns_ali -d <domain>` 对每个域名
   执行一次。`--server letsencrypt` 是显式写死的：acme.sh 自己的默认 CA 是
   **ZeroSSL** 而不是 Let's Encrypt（见
   [Server 说明](https://github.com/acmesh-official/acme.sh/wiki/Server)），
   不写这一项就会按执行主机上碰巧的默认值签发，和本文档承诺的 CA 不一致。根据
   acme.sh 官方说明，证书默认每 30 天检查一次续期（有 ACME Renewal
   Information 时以 CA 建议的窗口为准），Let's Encrypt 证书有效期 90 天，
   所以实际续期发生在到期前约 60 天，留有充足的重试窗口。已经签发且未到续期
   窗口的证书会被跳过（除非 `FORCE_RENEW=1`），这就是脚本可以反复安全运行的
   原因。
3. `acme.sh --deploy -d <domain> --deploy-hook ali_cdn` 只需要成功执行一次：
   acme.sh 会把这个部署钩子连同 `DEPLOY_ALI_CDN_DOMAIN` 一起写进该域名自己的
   配置文件里；官方文档确认这类部署配置「will be stored with the domain
   configuration and will be available when renewing, so that deploy will
   happen automatically when renewed」。也就是说，[第 5 节](first-run.md)的首次运行之后，
   之后每一次由 cron 触发的续期都会自动重新调用 `ali_cdn`，把新证书推送到
   CDN，不需要人再跑一次这个脚本——除非要检查/记录续期是否成功，或者
   `crontab -l` 显示 cron 任务丢失需要人工介入。
