# Panel tab order

These rules apply to `src/features/panel-tabs/`.

- Each member's tab order is persisted per Workspace membership through
  `WorkspaceMemberPreferences`. Panels resolve their default tab from it; do
  not add a per-panel store.
- Save through the `_app`-level provider in `panel-tab-order-context.tsx`,
  which applies optimistic, serialized saves. Tab strips render through
  `components/ui/reorderable-tab-strip.tsx`.
