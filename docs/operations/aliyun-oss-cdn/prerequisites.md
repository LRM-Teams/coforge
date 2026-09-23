# 1. 开始前的硬门禁

Frank 或其明确授权的阿里云 operator 必须先在变更记录中填写以下值；任何一项缺失都
停止在本节，不创建资源：

| 参数 | 要求 |
| --- | --- |
| `${ACCOUNT_ID}` | 两个 content bucket 与 CDN 必须在同一个阿里云账号；跨账号私有回源会要求长期 AK/SK，本方案禁止 |
| `${REGION}` | 两个 content bucket 与 OSS 日志 sink 使用同一 Region；由 Frank 定稿，不从仓库或 bucket 名推断 |
| `${ACCELERATION_AREA}` | 中国内地或全球加速要求有效 ICP；两个域名各自确认备案覆盖，未完成时不得选择这两项或切 CNAME |
| `${FILES_BUCKET}` | 全局唯一的私有用户文件 bucket 名；只承载聊天附件，不能包含环境外的业务含义 |
| `${IMAGES_BUCKET}` | 全局唯一的 profile image bucket 名（头像、项目图标），且不得等于 `${FILES_BUCKET}` 或 `${RELEASES_BUCKET}`；该域名不签名，bucket 内全部对象等同公开 |
| `${RELEASES_BUCKET}` | 全局唯一的发行 bucket 名，且不得等于 `${FILES_BUCKET}` |
| `${LOG_BUCKET}` | 已有的同账号同 Region private 日志 sink，或新建专用日志 bucket；不得作为 CDN origin |
| `${SLS_PROJECT}` / `${SLS_LOGSTORE}` | CDN real-time access log 的受限 SLS 目标与 retention |
| `${OPERATOR}` | 启用 MFA 的专用 RAM console user；不能使用聊天中的 AccessKey |
| `${FILES_URL_TTL}` | backend 与 CDN 一致的短时私有文件 URL TTL；验收可先用 console generator |

执行前先禁用并轮换任何曾在聊天中发送的长期 AK/SK。本 runbook 不需要把 AK/SK 写入
命令、文件或 CI；同账号 private OSS origin 必须选择阿里云推荐的 STS 临时 token
模式。
