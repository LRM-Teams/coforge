# `@lrm/coforge-sdk`

CoForge SDK contains client contracts and transports that can be shared by
the CoForge CLI, Daemon adapters, and other Agent runtimes.

## Agent module

Import Agent capabilities from the explicit subpath:

```ts
import { createAgentApiClient } from "@lrm/coforge-sdk/agent";
```

The Agent module describes the JSON API used by an Agent through the local
Daemon Proxy or by a trusted Daemon over HTTPS. It owns resource names,
request/response types, pagination, errors, and transport-independent client
interfaces.

It does **not** own Daemon lifecycle, database access, OSS credentials,
Centrifugo, or Protobuf encoding.

## Why this is separate from `@lrm/coforge-sdk/internal`

These packages serve different protocol boundaries:

| Package                     | Boundary                                     | Format                        |
| --------------------------- | -------------------------------------------- | ----------------------------- |
| `@lrm/coforge-sdk/agent`    | Agent/CLI/Daemon Agent API                   | JSON over local HTTP or HTTPS |
| `@lrm/coforge-sdk/internal` | Computer, Daemon, and realtime control plane | Protobuf over IPC/WSS         |

The SDK must not depend on the internal Protobuf protocol. Keeping the
boundaries separate lets Claude, Codex, Pi, and future runtimes use the Agent
API without importing the Computer/Daemon realtime protocol.
