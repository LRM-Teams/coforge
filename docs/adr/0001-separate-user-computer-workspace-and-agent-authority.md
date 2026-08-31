# Separate User, Computer, Workspace, and Agent authority

Status: proposed

Date: 2026-08-26

Decision gate: explicit approval from Frank is pending. This record does not authorize implementation.

CoForge needs a machine to continue serving Workspaces after the interactive User command has exited, while an Agent runtime must be able to perform only its own approved operations. The proposed decision is to use four non-interchangeable principals, broker Agent operations through a daemon-owned Credential Proxy, bind machine credentials to proof of possession, and version each protocol and persistence boundary independently. This prevents a long-running daemon or Agent process from silently retaining User authority.

## Context and constraints

- `login` is authentication-only. It may discover the authorization server, perform the OAuth device flow, save the User refresh credential, and list accessible Workspaces; it does not register a Computer, create a Workspace–Computer connection, or start a daemon.
- A Computer is a per-user background service identity. Background work must not continue as the User who originally registered it.
- Each resident daemon runtime connects outward to standalone Centrifugo. Centrifugo remains a transport component and does not acquire business or database ownership.
- Agent processes run third-party tools and are outside the trusted credential boundary. They must not receive a general bearer token or a generic token-retrieval API.
- Browser business APIs are outside this decision. OAuth discovery/device authorization/token endpoints and release or installer downloads remain standard HTTPS bootstrap/distribution paths; resident Computer and daemon business traffic uses versioned CoForge RPC.
- Exact RPC methods, wire fields, credential representations, cryptographic algorithms, and database schema are deliberately outside this proposal. Each requires a separately reviewed design and Frank's explicit approval before implementation.

## Proposed decision

### Principals and authorization audiences

| Principal             | Meaning and lifetime                                                                            | Authority                                                                                       | Must never be accepted as                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **User**              | A person authorizing one interactive Computer CLI management session                            | User-management operations explicitly granted to that User                                      | Computer background service, Workspace session, or Agent runtime           |
| **Computer**          | The long-lived service identity of one per-user installation profile registered with one issuer | Machine-level registration, proof rotation, and acquisition of sessions for its active bindings | The registering User or an unbound Workspace                               |
| **Workspace session** | A short-lived connection identity derived from one active Workspace–Computer connection            | Resident operations for exactly that Computer, Workspace, and connection                       | Another registration, User management, or an Agent operation without delegation |
| **Agent runtime**     | A short-lived capability and audited subject for one Agent within one Workspace runtime session | Only the operations, Workspace, and expiry recorded in its runtime binding                      | User management, Computer lifecycle, another Agent, or another Workspace   |

Remote RPC authorization has separate User, Computer/Workspace, and Agent-operation audiences and method namespaces. Authorization is the intersection of issuer, audience, principal kind, subject, Workspace/registration membership, allowed operation, expiry, and proof when required. A credential that passes signature validation but has the wrong audience or principal kind is rejected; there is no fallback or confused-deputy conversion between audiences.

The exact audience strings and method names are wire contract, not part of this ADR. Adding one, changing an audience, or moving a method between namespaces requires the wire approval gate.

### Communication and process boundary

```text
Bootstrap / distribution only
  coforge-computer -> OAuth discovery + device authorization/token over HTTPS
  coforge-computer -> release metadata and installer artifacts over HTTPS

Interactive management
  coforge-computer -> short-lived User-authorized CoForge RPC -> Centrifugo -> Backend

Resident service data plane
  daemon runtime -> long-lived Workspace-session CoForge RPC over WSS
                   -> standalone Centrifugo

Local control
  coforge-computer -> independently versioned CoForge RPC over UDS/named pipe
                   -> coforge-daemon

Agent operation
  Agent/coforge CLI -> private Credential Proxy RPC over local IPC
                    -> existing daemon runtime remote session
                    -> standalone Centrifugo
```

The remote and local profiles share protocol governance and authorization vocabulary, not necessarily framing or connection mechanics. Local control does not open a TCP management port, and a cloud credential cannot directly start, stop, upgrade, or otherwise control the local daemon. The launcher and local peer authorization establish the local lifecycle boundary.

### Daemon-owned Credential Proxy

Each daemon runtime owns the Credential Proxy for the Agent runtimes it launched. The proxy:

1. creates an in-memory binding from a runtime identity observed by the supervisor to one `agent_id`, one `workspace_id`, an allowlist of operations/scopes, and an expiry;
2. authenticates the local caller with an OS-backed peer/process boundary and matches it to that binding; the effective Agent subject always comes from the binding, never from a caller-supplied Agent ID;
3. exposes only approved typed RPC operations and never exposes `get-token`, refresh, arbitrary forwarding, or another audience's namespace;
4. obtains or refreshes any short-lived Agent credential only inside the trusted daemon runtime and records the Agent as the remote authorization and audit subject;
5. deletes the binding and invalidates later calls when the runtime stops, the Agent is revoked, the Workspace is unregistered, the Computer is revoked, or the binding expires; and
6. redacts authorization material, refresh credentials, pairing grants, and sensitive request bodies from logs, errors, traces, and metrics.

A user-level credential store is not a security boundary between processes running as the same OS user. The Credential Proxy therefore cannot claim containment from peer UID alone: the runtime launcher must also prevent an Agent process from opening the credential store, daemon state, or another runtime's local endpoint. If a supported platform cannot enforce that boundary, credential-bearing Agent operations fail closed. Treating every same-user process as trusted would be a weaker product boundary and requires an explicit separate risk acceptance.

### Credential and state storage

| Location                                       | Allowed state                                                                                                                                             | Forbidden state                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| OS credential store                            | User refresh credential; Computer proof private key; rotating/sender-constrained long-lived Computer credential                                           | Non-secret configuration used only for lookup or display                                                  |
| Owner-only standard application-data directory | `machine_id`, issuer/server reference, server Computer reference, selected Workspace/configuration, independent config schema version                     | Access tokens, refresh credentials, Workspace sessions, Agent credentials, pairing grants                 |
| Trusted process memory                         | Short-lived User access credential, single-use pairing grant, Computer access credential, Workspace session, Agent runtime credential and runtime binding | Persistence into config, JSON, SQLite, logs, crash reports, CLI arguments, or artifacts                   |
| Agent process                                  | Its private local RPC handle and non-secret runtime context                                                                                               | User, Computer, Workspace-session, or Agent bearer credentials; refresh material; credential-store access |

The OS credential store is mandatory: macOS Keychain, Linux Secret Service/libsecret, or Windows Credential Manager through the platform-supported credential API. If it is unavailable, credential creation or refresh fails without a plaintext fallback. Short-lived material is cleared on process exit and must be reacquired from the owning authority after restart.

### `machine_id`, registration, pairing, and proof

`machine_id` is generated locally on first registration as an RFC 9562 UUIDv4 from a CSPRNG. It identifies one per-user CoForge installation profile, not physical hardware, and is unique within one CoForge issuer. The server enforces that at most one active Computer identity for that issuer claims the same `machine_id`; a collision or clone is a conflict, never an implicit takeover.

The identifier is written atomically to the platform's standard per-user application-data directory with owner-only directory/file permissions. It survives Computer, Daemon, daemon runtime, and package upgrades. Losing or deliberately resetting that state creates a new `machine_id` and requires User-authorized registration; uninstall/reinstall does not recover authority from a hardware fingerprint. Copying the file does not copy authority because `machine_id` is public and machine proof is separate.

Registration is a User-authorized management operation and is not part of `login`. Its semantic request contains the issuer-scoped `machine_id`, a daemon-generated proof public key, a retry-stable idempotency identity, the supported protocol/package compatibility declaration, and non-secret user-visible machine metadata. These are semantic requirements, not approved field names. The server:

- creates a Computer or returns the same result for a retry by the same authorized User with the same `machine_id`, proof key, and idempotency identity;
- rejects a reused `machine_id` with a different owner or proof instead of merging or reassigning it;
- records no Workspace authority until a separately authorized Workspace–Computer connection exists; and
- returns a short-lived, single-use pairing grant bound to the issuer, Computer, and proposed proof key.

The Computer CLI passes only that pairing grant to coforge-daemon over authenticated local RPC. The daemon proves possession of the private key and redeems the grant once for a rotating, sender-constrained Computer credential. The private key never leaves the daemon's trusted boundary. Each remote Computer or Workspace session establishment proves possession and binds the proof to that session's protocol transcript; the exact proof algorithm and wire representation remain a mandatory pre-implementation approval item.

Revoking a Computer invalidates its Computer credential family, every Workspace session derived from it, every local runtime binding, and future reconnect/replay. Unregistering one Workspace invalidates only that registration's Workspace sessions and Agent runtime bindings. Revoking or stopping one Agent invalidates only that Agent's runtime bindings. User logout/revocation removes User authority but does not silently revoke an independently registered Computer; Computer revocation is an explicit management action. Refresh replay or cloned credentials revoke the affected credential family and require User-authorized repair/re-pairing.

### Independent version boundaries

Four numbers evolve independently:

1. **Remote CoForge RPC protocol major and capabilities** for daemon/Computer communication through Centrifugo;
2. **Local CoForge RPC protocol major and capabilities** for Computer↔daemon and Agent↔Credential Proxy communication;
3. **Local config schema version** for non-secret application state and its atomic migrations; and
4. **Computer and daemon SemVer**, released as separate components whose compatible pair is recorded in the immutable release set.

Package SemVer never implies a protocol or config version. Every RPC handshake identifies its protocol major and capabilities before business operations. An unknown major, a missing required capability, an unsupported audience, or an audience/method mismatch fails closed without downgrade. Within one major, changes are additive: new fields are optional, unknown safe fields are tolerated, and new capabilities are used only after negotiation. A retired field identity is reserved and never reused, including its number and name when the chosen schema has them; deleting, reinterpreting, or making a field required is a breaking change. Unknown methods are rejected rather than forwarded.

The exact envelope, version numbers, capability names, error codes, deprecation window, and schema technology remain unapproved wire design. Their proposal must include compatibility tests for the Bun client↔Centrifugo↔Backend path and the local UDS/Windows profile before implementation.

## Threats and failure modes

| Threat or failure                                               | Required behavior                                                                                                                        |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| User token remains in a daemon after an interactive command     | Daemon never receives it; only a separately registered Computer credential can outlive the command                                       |
| Cross-audience credential reuse                                 | Reject before method dispatch and record a redacted authorization failure                                                                |
| Agent claims another Agent ID or calls a token endpoint         | Ignore self-reported identity; derive the subject from the runtime binding; no token endpoint exists locally                             |
| Malicious same-user process calls the proxy or credential store | Require supervisor-attested peer binding plus runtime isolation; fail closed where the platform boundary is unavailable                  |
| Pairing grant is stolen or replayed                             | Bind it to issuer/Computer/proof key, keep it short-lived and memory-only, and consume it atomically once                                |
| Machine state is cloned                                         | Duplicate `machine_id` plus mismatched proof conflicts; credential-family replay revokes and requires repair                             |
| `machine_id` is lost or corrupted                               | Create a new identity only through explicit User-authorized registration; never infer authority from hardware                            |
| Credential rotation is interrupted                              | Keep at most the last confirmed credential family state; replay detection revokes uncertain families instead of accepting two writers    |
| Workspace is unregistered while offline                              | Server rejects reconnect and replay for that registration; daemon removes the local session/runtime bindings on reconciliation                |
| Runtime stops or is revoked during a call                       | Cancel/deny subsequent local calls and reject remote completion that no longer has valid runtime authority                               |
| Protocol downgrade or incompatible capability                   | Reject the handshake; do not guess, silently ignore a required capability, or fall back to an HTTP business endpoint                     |
| Older config/package is restored                                | Run only an explicitly supported atomic config migration and release-set compatibility pair; otherwise stop with an upgrade/repair error |
| Secret reaches diagnostics                                      | Redaction tests cover stdout/stderr, structured logs, errors, traces, crash reports, command lines, fixtures, and artifacts              |

## Considered alternatives

### Let daemon reuse the User refresh token

Rejected. It turns a short interactive authorization into indefinite background User impersonation and makes User logout, Computer revocation, and audit semantics inseparable.

### Give every Agent process a bearer token or `get-token`

Rejected. A compromised tool could exfiltrate, replay, or persist it and bypass the operation allowlist. The Credential Proxy keeps the credential and dispatch authority inside the trusted daemon runtime.

### Use one token audience and rely only on scopes

Rejected. Scope mistakes then become cross-principal confused-deputy paths. Principal kind, audience, registration membership, and method namespace are independent mandatory checks.

### Use loopback HTTP/TCP for local management

Rejected. It expands the listening surface, does not establish process identity by itself, and conflicts with the accepted UDS/Windows-equivalent control boundary.

### Derive `machine_id` from hardware or use it as proof

Rejected. Hardware identifiers clone, change, leak correlation, and are not secrets. A random installation identifier plus independent proof provides controllable reset and revocation semantics.

### Couple protocol versions to package SemVer

Rejected. Computer, daemon, cloud transport, local config, and transports roll out or roll back at different times. Coupling them creates unnecessary breaking upgrades and hides compatibility requirements.

### Select an RPC framework or schema in this ADR

Rejected for this decision. Identity/audience boundaries are independent of codec and framework, and current evidence for the Bun client↔Centrifugo↔Backend path plus local UDS/Windows support must be reviewed separately. Selecting one here would pre-approve unreviewed methods and fields.

## Compatibility, migration, and rollback

This is a pre-wire proposal, so no production Computer registration or Workspace-session data requires migration. After approval, implementation must be split into reviewed vertical changes rather than landing an implicit schema:

1. introduce the independent config schema and atomically create `machine_id` in the standard application-data directory;
2. migrate the current credential-store record so only the User refresh credential persists; discard any stored User access credential and require login when no refresh credential exists;
3. propose the exact local protocol/profile and pairing state machine, including failure, restart, redaction, and cross-audience tests, for Frank's explicit approval;
4. propose exact remote RPC methods, envelopes, credential lifecycle, proof algorithm, and any database effects for the same approval gate; and only then
5. implement the approved local and remote contracts, registration, registration sessions, Credential Proxy forwarding, revoke, and reconnect convergence.

Before a wire version ships, rollback is a documentation revert. After credentials are issued, rollback must never downgrade audience checks, reuse a retired field, copy access tokens back to disk, or accept a bearer-only Computer identity. A server may temporarily support two explicitly declared protocol majors during a measured rollout, but each session uses exactly one negotiated major and an immutable audience. If safe rollback cannot preserve the credential and config invariants, the client stops and requires upgrade or User-authorized repair.

## Validation and approval gates

Implementation proposals must demonstrate:

- cross-audience rejection for every method namespace;
- no bearer or refresh credential in Agent memory, config, logs, command lines, fixtures, or artifacts;
- immediate runtime/Agent/unbind/Computer revocation behavior, including offline reconnect;
- duplicate registration, concurrent retry, clone, lost state, interrupted rotation, protocol mismatch, and config rollback failure cases;
- local caller isolation on Linux, macOS, and Windows rather than assuming peer UID is process isolation; and
- Bun client↔Centrifugo↔Backend remote RPC and local IPC compatibility plus measured latency, throughput, allocation, backpressure, and reconnect/replay behavior.

Frank's explicit approval is required for this ADR and every later exact RPC method, wire field, credential lifecycle/algorithm, or database impact. Until then, registration, registration wire, remote Agent methods, and credential issuance remain blocked.

## Official references

- [RFC 8414: OAuth 2.0 Authorization Server Metadata](https://www.rfc-editor.org/rfc/rfc8414.html)
- [RFC 8628: OAuth 2.0 Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628.html)
- [RFC 8707: Resource Indicators for OAuth 2.0](https://www.rfc-editor.org/rfc/rfc8707.html)
- [RFC 9449: OAuth 2.0 Demonstrating Proof of Possession](https://www.rfc-editor.org/rfc/rfc9449.html)
- [RFC 9562: Universally Unique IDentifiers](https://www.rfc-editor.org/rfc/rfc9562.html)
- [RFC 9700: Best Current Practice for OAuth 2.0 Security](https://www.rfc-editor.org/rfc/rfc9700.html)
- [Bun secrets API](https://bun.com/docs/runtime/secrets)
- [Protocol Buffers field evolution guidance](https://protobuf.dev/best-practices/dos-donts/)

RFC 9700 requires audience restriction and either sender-constrained or rotating refresh tokens for public clients. RFC 9449 is evidence that proof-of-possession can sender-constrain OAuth credentials; it is not adopted here as the custom WSS proof wire format. RFC 9562 supplies the UUIDv4/CSPRNG identifier basis. Bun documents the native per-user credential stores and also makes clear that their access control is user-scoped, which is why the Agent process needs an additional local isolation boundary.
