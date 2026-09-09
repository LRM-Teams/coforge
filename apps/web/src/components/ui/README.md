# `src/components/ui/` — deviations from official components

Everything else in the app uses Untitled UI's official components unmodified
(`src/components/base/`, `src/components/application/`, installed via
`npx untitledui@latest add <name>`). The files in this directory are the only
hand-written UI primitives, kept here because Untitled has no equivalent for
them. Each one composes React Aria and/or official Untitled components at the
call site — none of them fork or copy an official component's source. See
`docs/ui-guidelines.md` §2.

| File                | Why it exists                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `empty.tsx`         | Untitled has icon/illustration empty-state examples in its docs but ships no reusable `Empty*` component. Restyled with Untitled's semantic tokens.                                                                                                                                                                                                    |
| `skeleton.tsx`      | Untitled has no generic loading-skeleton primitive.                                                                                                                                                                                                                                                                                                    |
| `toast.tsx`         | Thin wrapper around `sonner` (`Toaster`/`toast`), which Untitled doesn't ship a component for. Styled with Untitled tokens via `sonner`'s `--normal-*` CSS variables.                                                                                                                                                                                  |
| `relative-time.tsx` | CoForge-specific "6h ago" formatting + live re-render, built on the official `Tooltip`/`TooltipTrigger` (`@/components/base/tooltip/tooltip`) for the exact-timestamp tooltip.                                                                                                                                                                         |
| `input-otp.tsx`     | Thin wrapper around the `input-otp` library (which Untitled doesn't wrap), restyled with Untitled tokens.                                                                                                                                                                                                                                              |
| `hover-popover.tsx` | Untitled has no hover-triggered popover. Composed from React Aria's own `DialogTrigger`/`Popover`/`Dialog` (the same primitives Untitled's own components use internally) with `isNonModal` so the popover doesn't steal hover/focus from its trigger. Used by `features/computers/runtime-usage.tsx` and `features/agents/agent-activity-avatar.tsx`. |

Nothing outside this list should exist as a non-official component. If a page
needs something Untitled doesn't provide, compose it inline at the call site
from React Aria / official pieces first; only promote it to a new file here
if it's reused in more than one place, and add a row to this table explaining
why the official library has no equivalent.

## `src/components/layout/sidebar/` — the one sanctioned copy-and-adapt exception

`application/app-navigation/sidebar-navigation/sidebar-simple.tsx` and
`sidebar-slim.tsx` are official but are demo templates, not parameterized
components: they hardcode Untitled's own logo, a search box, and a fake
"Olivia Rhye" account card, and have no props for CoForge's actual
requirements (brand logo, no search, real account menu, resizable width).
They are copied into `src/components/layout/sidebar/` and adapted there —
once copied, they're CoForge's own code, no longer bound by "official source
unmodified". Everything they call into stays untouched: `app-navigation/
base-components/**` (`NavItemBase`, `NavButton`, `NavList`,
`MobileNavigationHeader`, `NavAccountCard`) and `components/base/**`.

## Lint config

## Lint config

`.oxlintrc.json` / `scripts/oxlint-plugin.js` may only be changed to exempt an
**unmodified official file** under `src/components/base/**` or
`src/components/application/**` from a `coforge/no-native-*` rule (each
override names the specific file, with the reason in the commit message).
Product code — this directory, `src/features/**`, `src/components/layout/**`,
routes, tests — is never exempted; a lint hit there means fix the code (see
`relative-time.tsx`'s `aria-label` fallback for an example), not loosen the
rule. No `oxlint-disable`, `@ts-ignore`, or `@ts-expect-error` comments
anywhere in the codebase.
