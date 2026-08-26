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
