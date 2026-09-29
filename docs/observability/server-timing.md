# Server-Timing

Web/backend 在 `COFORGE_SERVER_TIMING=1` 时，为 SSR 文档（`text/html` 响应）和 Server Function
响应追加 [W3C Server Timing](https://www.w3.org/TR/server-timing/) 头：

```
Server-Timing: total;dur=16.6, db;dur=9.5
```

浏览器 DevTools 的 Network → Timing 面板和 `PerformanceResourceTiming.serverTiming`
（导航条目与 `/_serverFn/` 资源条目）直接读取它
（[MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Server-Timing)）。

| 指标 | 含义 |
| --- | --- |
| `total` | CSRF 检查之后、其余中间件与处理器开始到响应头就绪的毫秒数。SSR 为流式响应，它覆盖 loader、dehydrate 与首段渲染，不含其后的流传输。 |
| `db` | `total` 内至少有一条 Prisma 查询在执行的毫秒数（并发查询只算一次，含连接池等待），因此不超过 `total`。 |

`/api` 下的非 HTML Server Route 不带此头；`/api/agent/*` 的耗时见结构化日志 `agent_http.request_finished`。

## 实现

`src/start.ts` 中紧跟 CSRF 检查的请求中间件调用 `withServerTiming`
（`src/server/observability/server-timing.server.ts`）。它用 `AsyncLocalStorage` 把 Prisma
`query` 事件归到发起它的请求；请求之外的查询（后台 sweep）被丢弃。开关关闭时 Prisma 不开启 query
事件，因为开启后每条查询都要格式化参数。

## 安全边界

头里只有两个固定指标名和数字 `dur`，没有 `desc`，不含路径、ID、查询文本或用户数据；服务端不发送
`Timing-Allow-Origin`，所以跨源页面读不到它。但任何能发出请求的人（包括未登录访问登录页的人）都
能在响应里看到 DB 耗时拆分，它比总响应时间更精确，可能帮助基于时延的探测。W3C 规范的隐私与安全
一节允许服务端只向已认证用户提供这些指标。

因此默认关闭，只有 staging 在 `infra/staging/docker-compose.yml` 中开启。生产环境是否开启、或改为
只对已登录会话发送，须经 Frank 批准。
