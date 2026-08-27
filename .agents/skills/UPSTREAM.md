# Vendored skill provenance

The skills in this directory come from
[`mattpocock/skills`](https://github.com/mattpocock/skills) at upstream `main`
commit `6654f6b60cd9d5be8b54c6fafe44346dabeb3b76`:

- `code-review`
- `codebase-design`
- `domain-modeling`
- `tdd`

They were installed with the official AI Hero installer, run through the
repository's pinned Node toolchain:
`mise exec -- npx --yes skills@1.5.23 add mattpocock/skills`. `skills-lock.json`
records each skill's upstream path and computed content hash. Review upstream
changes before running
`mise exec -- npx --yes skills@1.5.23 update --project --yes`, and commit the
resulting lockfile and vendored files together. Updating the installer version
is a separate reviewed change.

The upstream project is distributed under the MIT License; see
`LICENSE.mattpocock-skills` in this directory.

TanStack framework skills are vendored from the project dependencies installed
by Bun and are covered by TanStack's MIT license:

- `tanstack-react-start` from `@tanstack/react-start@1.168.49`
- `tanstack-router-core` from `@tanstack/router-core@1.171.27`
- `tanstack-router-plugin` from `@tanstack/router-plugin@1.168.35`
- `tanstack-start-client-core` from `@tanstack/start-client-core@1.170.27`
- `tanstack-start-server-core` from `@tanstack/start-server-core@1.169.31`
- `tanstack-virtual-file-routes` from `@tanstack/virtual-file-routes@1.162.0`

Refresh these files by reinstalling the pinned dependencies and copying their
`skills/` directories into the corresponding project skill directory. Keep
the dependency versions, vendored files, and this provenance note in sync.
