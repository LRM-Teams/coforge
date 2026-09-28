# OpenTelemetry Tracing

Web/backend 为一次 `sendDirectConversationMessage` 创建 `message.send` 根 span，并包含
`message.context` 和 `message.persist_and_publish` 子 span。仅记录 request ID 和 Agent ID，
不记录消息正文、凭据、Cookie 或接入 Token。导出采用 OTLP/HTTP protobuf 的批量发送，导出失败
不得阻塞消息发送。

部署通过 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_FILE` 从 Compose secret 读取完整接入地址；完整
地址只存在于 GitHub Environment Secret 和远端受限文件中，不进入 Git、镜像、`.env`、日志或发布
记录。`OTEL_SERVICE_NAME` 和 `OTEL_DEPLOYMENT_ENVIRONMENT` 是非敏感运行配置。
