---
status: accepted
date: 2026-08-26
---

# MVP 使用 standalone Centrifugo 与自托管 Redis/PostgreSQL

CoForge MVP 使用 Caddy 作为唯一公网 edge、standalone Centrifugo OSS 作为实时传输服务、Bun Backend 作为业务控制面；Redis 与 PostgreSQL 先使用官方 Docker image 自托管。这个决定替代自定义 Go realtime-gateway、Fiber 与 embedded Centrifuge 的 production 方向，目标是在保留长期 WSS 与 Backend 故障隔离的同时减少自研连接基础设施。

该组件边界由 Frank 在 `#coforge` seq 767/773/774 批准，并由 LRM-1581 的固定证据验证：文档 HEAD [`4e0a4bcc6a0c636af287abbbb6a443f29fc4cd4b`](https://github.com/LRM-Teams/coforge/commit/4e0a4bcc6a0c636af287abbbb6a443f29fc4cd4b)，已独立复现的行为 SHA [`6a39086e5e73f91cf9b287306f20164c3edcb8c5`](https://github.com/LRM-Teams/coforge/commit/6a39086e5e73f91cf9b287306f20164c3edcb8c5)。证据是 disposable spike，不是 production wire、schema、migration 或部署配置。

## 决定

### 服务拓扑与职责

- Caddy 是唯一公网入口，终止 TLS，并把 HTTPS 路由到 Web/Backend、把 WSS 路由到两个 Centrifugo 副本。Caddy 只做 edge proxy、健康检查与负载均衡，不理解 User、Workspace、Computer、Agent、conversation 或 message。
- Centrifugo OSS 是独立 realtime transport service。它持有 Web/workspace-daemon 长连接，负责连接/session mechanics、心跳、背压、重连、RPC/订阅 framing、跨副本 fan-out、presence 与 bounded hot recovery；它不读取 PostgreSQL，不决定 binding、权限、目标 Agent 或 canonical message。
- Bun Backend 通过 Centrifugo 官方 HTTP/gRPC proxy 与 server API 处理连接授权、业务 RPC、发布和必要的断开；Backend 始终拥有 User/Workspace/Computer/Agent 权限、Workspace–Computer binding、conversation、canonical message、delivery ledger、幂等提交与 PostgreSQL。
- `workspace-daemon` 仍按逻辑 Workspace 各自发起一条 WSS。`coforge-computer` 只管理本机 `coforge-daemon`，不成为远程 realtime endpoint。
- Centrifugo↔Backend 最终选 HTTP 还是 gRPC、channel/rpc namespace、method、field、error、capability 和版本行为都不在本 ADR 中锁定；这些必须在身份、credential audience、binding 与 wire approval packet 通过后才能实现。

### 在线视图与两副本边界

- MVP 运行两个 Centrifugo 副本并共享 Redis engine。Redis broker 负责把任一副本的 publication fan-out 到持有目标连接的副本，Redis presence 让任一副本返回同一 hot online view。
- Backend 重启不终止 Centrifugo 持有的既有 WSS；Backend 不可用期间需要业务判断的 RPC 必须显式失败，不能伪装成功。Backend 恢复后，以 PostgreSQL 中已知的 Workspace–Computer binding 集合为枚举边界，从 Centrifugo/Redis presence 重建完整在线视图。
- Centrifugo 副本、Caddy route 或客户端网络中断仍会断开对应 WSS。客户端必须重连并重新认证；无法完整 hot-recover 时，Backend 从 PostgreSQL canonical state 与 workspace-daemon durable spool 执行 reconciliation/replay。
- `online` 与 `last_seen_at` 不是持久化真相。在线状态只从当前 Workspace–Computer binding 的已认证 workspace-daemon session 派生，不能由同一 Computer 在其他 Workspace 的连接代替。

### 数据与耐久性

- PostgreSQL 是 Backend canonical message、delivery ledger、binding 与其他业务状态的 durable source of truth。MVP 使用官方 PostgreSQL Docker image、认证、私有 Compose 网络和独立 named volume。
- 每个 workspace-daemon 的 durable inbox/outbox spool 是机器侧接管、重试与去重真相。ACK 只在本地 durable accept 后返回；spool 的生产格式、加密、保留和损坏恢复仍需单独批准。
- Redis 只承担 Centrifugo 的 broker、presence 与 bounded hot history。Redis volume 用于改善操作连续性，不把 Redis 提升为 canonical durability；Redis 数据丢失、epoch 变化或容器替换都必须可由 PostgreSQL + spool 恢复。
- Centrifugo history/recovery 只能降低重连成本，不能替代 canonical message、per-Agent delivery 或本地 spool。容器重建也不等于数据库恢复、应用回滚或消息 replay。

### MVP Compose 与后续托管迁移

- Centrifugo、Redis 与 PostgreSQL 使用经过评审且按 digest 固定的官方 image；禁止 `latest`。LRM-1581 验证的版本是 Centrifugo OSS v6.8.4、Redis 8.2.6、PostgreSQL 18.6 与 Caddy 2.11.4，但 spike 版本不会自动成为 production pin。
- Redis 与 PostgreSQL 不暴露 host/public port，只接入 private Compose network，启用认证、healthcheck 与不同 named volume。凭据只经部署 Secret 注入，不进入仓库、日志、命令参数或镜像。
- PostgreSQL 上线门禁必须实际执行 logical backup、在全新 container + volume 中 restore、校验业务 fingerprint，并验证错误凭据/损坏备份 fail closed。仅保留原 volume 或重启容器不算恢复证据。
- Redis 改为托管服务时只替换配置与 Secret，接受 hot state 重建，并在 drain/reconnect 后用 presence 与 canonical reconciliation 验证。PostgreSQL 改为托管服务必须走受控 backup/restore 或复制迁移、双侧校验和明确 cutover/rollback；不得把 endpoint 切换当作数据迁移。
- Redis 8 官方版本提供 RSALv2、SSPLv1、AGPLv3 三种选择；LRM-1581 仅以未修改 image 的 AGPLv3 选项做 spike。production image/version/license 在法务与 license gate 记录前不得发布；若不批准，替换兼容 broker 需要新的架构决定和同等故障证据。

## 未选择的方案

- **自定义 Go realtime-gateway**：会重复实现成熟的连接、RPC、presence、recovery 与多副本原语，并增加长期维护面。现有 skeleton 是待删除的 obsolete artifact，不允许继续扩展为 production 路径。
- **Fiber + embedded Centrifuge**：技术 spike 已证明可行，但仍需维护自定义 Go server、adapter 与版本隔离；相比 standalone Centrifugo 没有足以抵消自研成本的 MVP 收益。
- **workspace-daemon 直接连接 Bun Backend**：服务更少，但 Backend 发布、崩溃与连接风暴会与业务 API/数据库生命周期耦合，无法满足已批准的 Backend restart isolation。
- **MVP 立即购买托管 Redis/PostgreSQL**：不是可行性问题，而是不符合 MVP 成本边界；adapter/config seam 与恢复门禁保留以后迁移能力。
- **把 Redis/Centrifugo 当 durable queue**：Redis restart 已观察到 hot-history epoch 丢失，且 Centrifugo recovery 明确允许返回无法完整恢复；这不能满足 CoForge 的 durable accept、replay 与去重语义。

## 失败、回滚与验证

| 故障或变更 | 必须出现的行为 | 禁止的解释 |
| --- | --- | --- |
| Backend 单/双副本重启 | 既有 WSS 留在 Centrifugo；业务 RPC 短暂显式失败并恢复；在线视图重建完整 | 把失败伪装为成功或 offline |
| Centrifugo 滚动 | 受影响连接重连、重新认证；健康副本继续接新连接 | 声称 WSS 穿越所属进程死亡 |
| Redis 中断/替换 | publish/presence/history 显式失败或 hot state 重建；canonical message 与 spool 不丢 | 把 Redis volume/history 当 delivery truth |
| PostgreSQL container/volume 丢失 | 从独立 backup 恢复到 clean storage，并校验 canonical fingerprint | 把重建 container 当 restore |
| Caddy reload/route 变化 | drain 或有界 reconnect；公开 WSS/HTTPS seam 恢复后才健康 | 只以 container health 代替 edge 可用性 |
| 托管迁移失败 | Redis 可退回原 endpoint 并重建 hot state；PostgreSQL 按已验证 cutover plan 回到原 canonical endpoint | 双写未验证、静默丢数据或回退到旧 schema |

LRM-1581 在固定行为 SHA 上独立通过 11/11 black-box cases、34 assertions、PostgreSQL clean-volume restore、workspace-daemon spool probe、Backend/Centrifugo/Redis/network faults 与 2,000 次 Protobuf RPC benchmark。production 仍必须补充部署配置评审、Redis license gate、身份/credential/binding/wire approval、备份保留与定期 restore drill。

## 一手资料

- Centrifugo 的 [server design](https://centrifugal.dev/docs/getting-started/design)、[HTTP/gRPC backend proxy](https://centrifugal.dev/docs/server/proxy)、[HTTP/gRPC server API](https://centrifugal.dev/docs/server/server_api)、[Redis engine 与多节点](https://centrifugal.dev/docs/server/engines)、[history/recovery 失败语义](https://centrifugal.dev/docs/server/history_and_recovery) 与 [Apache-2.0 repository](https://github.com/centrifugal/centrifugo)
- Caddy [`reverse_proxy`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) 的 WebSocket、health check 与 streaming/reload 行为
- Docker Compose 的 [service/healthcheck](https://docs.docker.com/reference/compose-file/services/)、[internal network](https://docs.docker.com/compose/how-tos/networking/) 与 [named volume](https://docs.docker.com/reference/compose-file/volumes/) 契约
- Docker Official Images：[Redis](https://hub.docker.com/_/redis) 与 [PostgreSQL](https://hub.docker.com/_/postgres)
- PostgreSQL 官方 [`pg_dump`](https://www.postgresql.org/docs/current/app-pgdump.html) / [`pg_restore`](https://www.postgresql.org/docs/current/app-pgrestore.html) 与 Redis 官方 [license matrix](https://redis.io/legal/licenses/)
