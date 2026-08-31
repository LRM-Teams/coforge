---
name: using-bun-runtime
description: Applies Bun-first runtime and package-management practices in CoForge. Use when adding or changing Bun code, Node compatibility imports, filesystem or process APIs, sockets, cryptography, tests, or dependencies.
compatibility: Bun 1.4; CoForge packages target Bun and must not use Node as the runtime.
---

# Using Bun Runtime

Use Bun-native APIs where Bun provides an equivalent. Use Bun's documented
Node compatibility modules when no Bun-native equivalent exists or when the
compatibility API preserves a required platform, permission, atomicity, or
terminal behavior.

## Decision rules

- Use `Bun.file` and `Bun.write` for ordinary file reads and writes when they
  are not coupled to permissions or atomic replacement.
- Use `Bun.file(path).exists()` for asynchronous existence checks; do not add
  `node:fs` only for a simple existence check.
- Use `Bun.env` for environment access. Prefer `process.platform` for the
  current OS; use `node:os` only for OS helpers with no Bun equivalent, such
  as `homedir()` and `tmpdir()`.
- Use `Bun.spawn`/`Bun.spawnSync` for child processes.
- Use `Bun.which` to resolve executables on `PATH` instead of spawning `which`
  or importing a command lookup package.
- Use `Bun.$` for short, intentional shell pipelines only when argument
  boundaries and shell behavior are explicit; use `Bun.spawn` for supervised
  long-lived processes and protocol-driven children.
- Use `Bun.listen`/`Bun.connect` for TCP, Unix sockets, and local IPC.
- Use `Bun.serve` for Bun-owned HTTP/WebSocket servers. Keep framework-owned
  HTTP handlers in the framework rather than wrapping them in `Bun.serve`.
- Use `Bun.secrets` for new OS-keychain access when its platform behavior fits;
  preserve the repository's credential-store abstraction at the domain
  boundary.
- Use `Bun.sql` or `Bun.redis` only when the owning module explicitly owns
  direct database/Redis access; do not move Web/backend persistence into a
  local app or daemon merely because Bun provides a client.
- Use `Bun.CryptoHasher`, `Bun.hash`, or Web Crypto for new hashing and crypto
  work when their API fits the requirement. Keep `node:crypto` for PEM public
  key import and synchronous signature verification unless an equivalent
  migration is intentionally designed and tested.
- Use `bun:test` for tests and `bun add`/`bun remove` for dependency changes.
  Never hand-edit `package.json` or `bun.lock`.
- The repository's `.oxlintrc.json` rejects Node networking, HTTP, TLS, and
  child-process imports that have Bun-native alternatives. Treat a lint error
  as a required implementation change, not something to silence. If a
  genuinely platform-specific exception is necessary, add a narrow inline
  lint disable with the reason and link it to the relevant Bun documentation.

## Approved Node compatibility cases

These imports are valid in Bun and should not be mechanically replaced:

- `node:fs/promises` for `mkdir`, `readdir`, `access`, `chmod`, `rename`,
  `rm`, `symlink`, and other filesystem operations not covered by Bun's file
  APIs. Keep it for writes that require a file mode or atomic replacement.
- `node:path` for path joining and `posix`/`win32` semantics. Bun has no
  Bun-native path manipulation API.
- `node:os` for `homedir` and `tmpdir`.
- `node:readline` for raw terminal keypress handling.
- `node:util` for `stripVTControlCharacters`.

When adding one of these imports, mention the compatibility reason in the
change if it is not obvious from the surrounding code. Do not replace a
platform-sensitive operation with a hand-written wrapper just to remove a
`node:*` prefix.

## Verification

Check the repository runtime before relying on an API:

```sh
bun --version
bun run check
bun test
```

For a new API, consult the official Bun documentation rather than assuming a
Node API has a Bun-native counterpart. The current references are:

- [Bun File I/O](https://bun.com/docs/runtime/file-io)
- [Bun APIs](https://bun.com/docs/runtime/bun-apis)
- [Bun Node.js compatibility](https://bun.com/docs/runtime/nodejs-compat)
- [Bun `node:fs/promises` reference](https://bun.com/reference/node/fs/promises)
- [Bun `node:crypto.verify` reference](https://bun.com/reference/node/crypto/verify)
