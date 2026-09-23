# Computers UI

These rules apply to `src/features/computers/`.

- `computer-layout.tsx` owns Computer list/detail selection, the return
  control, list scroll retention, and the empty state, following the same
  list/detail rules as Chat (`docs/design.md` §2.1).
- Only runtimes marked in `RUNTIME_PROVIDER_USES_EXTERNAL_CLI` get on-demand
  Usage scanning. Pi, CoForge, and runtimes reporting unsupported Usage render
  as plain, non-focusable identities.
