import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { RUNTIME_PROVIDER_DISPLAY_ORDER } from "#src/features/agents/runtime-provider-display";

// `RUNTIME_PROVIDER_DISPLAY_ORDER` is a plain array, so the compiler cannot force every
// RuntimeProvider value into it the way `Record<RuntimeProvider, ...>` forces the label and mark
// tables. This test is that check instead: CoForge is offered by the runtime picker separately
// from this list (it is always shown), so the list must hold exactly every other provider value.
test("RUNTIME_PROVIDER_DISPLAY_ORDER lists every RuntimeProvider except CoForge", () => {
  const expected = Object.values(RUNTIME_PROVIDER).filter(
    (provider) => provider !== RUNTIME_PROVIDER.COFORGE,
  );
  expect([...RUNTIME_PROVIDER_DISPLAY_ORDER].sort()).toEqual([...expected].sort());
});
