# coforge-daemon

`coforge-daemon` is the single machine-local daemon owned by Computer. Its MVP
topology is deliberately small:

```text
Computer --Unix socket--> Daemon --one WSS--> server
                              └─ N Agent runtime OS child processes
```

The daemon owns one configured logical Workspace connection and an
`AgentProcessManager` that starts and stops any number of provider-neutral Agent
runtime processes. Computer can configure, start, stop, and restart the daemon;
it cannot operate Agents directly.

After the server handshake/`ready` flow, the server may deliver an `agent.start`
intent containing `agentId`, the complete `AgentRuntimeConfig`, and an optional
`sessionId`. A missing session starts a new session; a supplied session remains
a provider-neutral resume seam. The daemon emits normalized Agent events over
the same WSS. It does not pretend to implement provider-specific resume or
server push until those transports exist.

`stopAll()` stops every locally owned Agent runtime and the daemon transport.
There is no Daemon process, worker supervisor, runtime pool, capacity
policy, cross-Workspace scheduler, or Computer-to-Agent RPC.

Computer setup replaces the single active binding by issuing `stopAll` first,
then configuring and starting the new Workspace. A failed replacement leaves
the previous Computer registration on disk and reports an error; the daemon
does not claim a remote unregister because that operation is not in the
current server contract.
