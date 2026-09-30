# Studying the reference Computer 1.0.38

Read this before researching how the reference Computer works. The reference
is the shipped binary **1.0.38**, `darwin-arm64` sha256
`d6973542b7f0ec1b12f062afdaf35cdeff3e803986452452cb77bbe728fe049d`.

Do not substitute another version, including whatever `latest` returns today
(1.0.40 on 2026-09-30). The npm registry still hosts
`@botiverse/raft-computer` (last 0.0.70) and `@botiverse/raft-daemon`
(1.0.17). Those are older, differently packaged builds whose command surface,
lifecycle code, and contracts differ, so conclusions drawn from them do not
describe the product being compared. Use them for nothing except confirming
that the source is esbuild output with paths preserved.

The reference Computer is the closest shipped analogue to `coforge-computer`:
one native executable that hosts the human-facing control-plane CLI, the
resident daemon, and the agent-facing `raft` CLI, and registers itself with
launchd/systemd on `start`. Installing and upgrading it is the job of a
separate native installer.
The GitHub repository (`botiverse/slock`) is private, so the source is
recovered from the binary.

## Topics

- [Recovering the binary and its source](recovering-the-binary.md): where the
  1.0.38 download and hashes come from, and how to cut the JS bundle out of
  the single-executable file and split it by path.
- [What the extracted tree contains](source-tree.md): the package table, the
  agent-facing `raft` command tree, the human-facing `raft-computer` commands,
  where to start reading, and the vendored dependencies.
- [The separate installer](installer.md): how upgrades launch a native
  installer fetched at upgrade time, and how to recover that installer.

Compare with [`docs/release/`](../../release/README.md).

## Boundaries

- The repository is private and carries no license. Read for design
  comparison only. Do not copy code, identifiers, or prose into CoForge.
- Record conclusions in your own words and cite the path in the extracted
  1.0.38 tree, or the command name inside the daemon bundle, so a reviewer can
  re-derive them.
- Every offset, hash, count, and command list in these documents was observed
  on 2026-09-30 for 1.0.38 `darwin-arm64`. If the comparison target ever moves
  to a different version, update these documents rather than mixing versions.
