# coforge-daemon

`coforge-daemon` is the single machine-local daemon owned by Computer. Its MVP
topology is deliberately small:

```text
Computer --Unix socket--> Daemon supervisor
                              ├─ Workspace runtime A --one WSS--> server
                              └─ Workspace runtime B --one WSS--> server
```

The daemon supervisor owns the machine-wide process and maintains one isolated
resident runtime per configured Workspace. Each resident runtime owns its
Workspace connection, Agent process manager, workspace root, credentials, and
activity/status state. Computer can add or reconfigure a Workspace through the
local RPC seam, but it never discovers providers or operates Agents directly.

After the server handshake/`ready` flow, the server may deliver an `agent.start`
intent containing `agentId`, the complete `AgentRuntimeConfig`, and an optional
`sessionId`. A missing session starts a new session; a supplied session remains
a provider-neutral resume seam. The daemon emits normalized Agent events over
the same WSS. It does not pretend to implement provider-specific resume or
server push until those transports exist.

`stopAll()` stops every locally owned Agent runtime and the daemon transport.
The machine supervisor is responsible only for lifecycle and routing local RPC
to the selected Workspace runtime. It is not a cross-Workspace scheduler or
capacity policy, and it does not expose Computer-to-Agent RPC. Runtime
inventory is discovered by each Daemon-owned Workspace runtime and published
through that runtime's authenticated cloud connection.

Computer setup adds or reconfigures only the selected Workspace binding and
asks the supervisor to ensure that runtime is started. It does not stop other
Workspace runtimes and does not send provider inventory. A failed replacement
leaves the previous Computer registration on disk and reports an error; the
daemon does not claim a remote unregister because that operation is not in the
current server contract.
