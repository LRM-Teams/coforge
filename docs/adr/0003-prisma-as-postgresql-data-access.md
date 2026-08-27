---
status: accepted
date: 2026-08-27
---

# 使用 Prisma 作为 PostgreSQL 数据访问标准

CoForge 的 Web/backend 需要访问 PostgreSQL。团队更看重统一的开发方式、明确的
schema/client/migration 工作流，以及对 code agent 行为的约束，而不是让每个功能
直接使用 PostgreSQL 的全部自由度。开发阶段的 PostgreSQL 运行在团队自有的 Docker
环境中；生产阶段预留迁移到阿里云 RDS PostgreSQL 的能力。

## 决定

- Web/backend 统一使用 Prisma ORM、Prisma schema、生成的 Prisma Client 和 Prisma
  Migrate 管理 PostgreSQL 数据访问。
- Prisma Client 只存在于 `apps/web/src/server/db/` 等 server-only 模块；路由、React
  组件和共享 domain/protocol package 不直接导入 Prisma 或数据库驱动。
- 所有 schema 变更先修改 Prisma schema，再生成 migration；migration 必须审查并纳入
  版本控制。禁止在应用启动时自动 push、reset 或修改数据库 schema。
- 业务查询通过 repository/service seam 暴露；只有确有必要且经过审查时，才在 server
  模块中使用 Prisma 的 tagged raw SQL 能力表达 PostgreSQL 特性，并保留可审查的
  migration 与参数化查询。
- 本地与云端都使用 PostgreSQL，不把 SQLite 作为应用行为的替代测试数据库。测试需要
  数据库语义时使用隔离的 PostgreSQL 数据库或容器。
- 连接配置只来自运行时 Secret/environment。默认开发数据库由 Docker 提供；阿里云
  RDS PostgreSQL 只替换连接配置和运维流程，不改变应用数据访问边界。

## 未选择的方案

- **Drizzle ORM**：类型和 SQL 组合能力优秀，但团队已选择 Prisma 的更强约定、生成
  client 与 agent skills 工作流作为标准化收益。
- **直接使用 `pg` 或 repository 中手写 SQL**：能暴露更多 PostgreSQL 能力，但会让
  schema、参数校验、迁移和查询风格分散，增加 code agent 产生不一致实现的风险。
- **把 ORM 选择推迟到具体业务实现**：会导致第一批 schema 和 service 形成事实标准，
  之后迁移成本更高。

## 后果与迁移计划

- 团队获得单一的 schema、client、migration 和数据库测试入口；项目中的 Prisma agent
  skills 作为实现与审查参考。
- Prisma schema 不是 PostgreSQL 所有能力的替代品。partial index、特定约束或复杂
  查询可以通过审查过的 SQL migration/raw SQL 补充，但不能绕过 repository/server
  边界。
- 当前不引入业务 schema、migration、Prisma Client 或 Docker Compose；它们在数据库
  表和服务 contract 通过评审后单独实现。
- 从本地 Docker PostgreSQL 迁移到阿里云 RDS 时，必须按备份、恢复/复制、双侧校验、
  cutover 和 rollback 计划执行，不以更换 endpoint 代替数据迁移。

## 验证与回滚

- 实现阶段必须验证 `prisma validate`、生成 client、migration 在干净 PostgreSQL
  数据库上的 apply，以及相关测试、check 和 build。
- CI 必须阻止未生成或无法应用的 migration；生产部署只执行已审查的 migration，不能
  使用 `db push` 或 `db reset`。
- 若 Prisma/Bun/目标 PostgreSQL 或阿里云 RDS 出现无法接受的兼容性问题，可在新的
  ADR 中替换数据访问层；在此之前保留 PostgreSQL schema 和数据备份，不把回滚定义为
  删除既有 migration。

## 一手资料

- Prisma [ORM documentation](https://www.prisma.io/docs/orm)
- Prisma [Migrate documentation](https://www.prisma.io/docs/orm/prisma-migrate)
- Prisma [PostgreSQL database connector](https://www.prisma.io/docs/orm/overview/databases/postgresql)
- Prisma [Bun guide](https://www.prisma.io/docs/guides/runtimes/bun)
- Alibaba Cloud [RDS PostgreSQL](https://www.alibabacloud.com/help/en/rds/apsaradb-rds-for-postgresql)
