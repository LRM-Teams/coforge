# Release tracks and immutable identities

| Track                       | Candidate identity                                                                                                                                                       | Test target                                                  | Production effect                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Cloud application           | Full `registry/repository@sha256:...` image reference                                                                                                                    | `staging` GitHub Environment and Compose project             | Deploy the same digest to production Compose                                                          |
| Local Computer distribution | A release version plus its manifest's SHA-256 checksum for every platform's unified Computer executable and for the one platform-independent `photon_rs_bg.wasm` sidecar | Version published behind the staging feed's `latest` pointer | Build the same commit against the production feed, publish it, then point production's `latest` at it |

The daemon runtime role is released inside `coforge-daemon`; it is not a third local
product component. `@coforge/agent` is independently packable for dependency and
verification purposes, but the exact installed package remains part of the
Daemon component payload rather than becoming a third user-facing component.

Computer and Daemon remain two independently buildable source packages -
Computer declares Daemon as a build dependency, and Daemon declares an exact
`@coforge/agent` runtime dependency - but release builds compile both roles
into one native `coforge-computer` executable under one shared version. A
standalone Daemon build may remain a test/development artifact, but it is never
published in the user distribution. Every publication records one executable's
byte size and SHA-256 checksum per target. There is no separate release-set
digest, per-component manifest, or installation-bundle archive: integrity
comes from TLS in transit plus the manifest's checksums.

Users install, upgrade, and invoke only Computer. Its main entry dispatches
`__daemon` to the Daemon runtime, `__agent-cli` to the existing
`@lrm/coforge/runner`, and ordinary arguments to the Computer management CLI.
Daemon still runs as an independent OS process over the existing Unix socket;
sharing executable bytes does not collapse that runtime boundary. Build-time
release version injection must give both roles the same version.
