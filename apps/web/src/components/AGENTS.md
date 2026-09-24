# Shared components

These rules apply to `src/components/`. `ui/README.md` lists the sanctioned
primitives and the lint-exemption policy.

- Keep `layout/` limited to layout concerns and `ui/` limited to reusable UI
  primitives. Do not turn either directory into a catch-all for feature
  behavior.
- `base/` holds official MIT Untitled UI source installed with its CLI.
  Preserve upstream APIs and interaction logic; adapt feature callers instead.
- `ui/` holds compatibility adaptations and product-specific primitives, not
  unmodified official components.
- CoForge color tokens remain authoritative. The `.untitled-ui` class scopes
  the official components' semantic theme mapping, including their portaled
  popovers.
- Native button leaves are allowed only in the shared Button/Select/Tooltip
  adapters that implement React Aria render semantics; feature code uses
  components.
- An official Tooltip `title` prop is not a native HTML `title` attribute.
- `ui/empty.tsx` supplies presentation only; the owning feature chooses the
  icon, localized copy, and empty-state condition.
- `ui/skeleton.tsx` owns decorative placeholder styling only; loading
  placeholders themselves belong to the owning feature.
- The global navigation drawer (`layout/sidebar/`) contains global
  destinations only, never channel or direct-message lists or their creation
  actions. Pages own their titles and actions; `mobile-header.tsx` only
  connects page-owned mobile menu controls to the drawer.
