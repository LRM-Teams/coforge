# Recovery verification

## Recovery checkpoint verification

The Provider-based test passed on 2026-09-14: **1 pass, 0 fail, 11 assertions**
in 82.41 seconds with the environment's real OpenRouter key. `mise run check`
and `mise run build` passed. `mise run test` failed in ConversationHistory's
around-window test and runtime inventory's catalog test; the full suite is not
green.

Oracle's focused review permits draft preservation, not merge approval. Open
findings: the restored three-catalog bound rejects supported multi-Provider
inventories; Kiro usage behavior/tests were lost in the older snapshot; catalog
refresh before managed credential installation misses managed-key-only cold
starts. Resolve these and rerun checks before requesting merge approval. The
review did not cover all recovered Task/schema changes.

## Follow-up verification

The checkpoint regressions above are now fixed. `mise run test`,
`mise run check`, and `mise run build` all passed on 2026-09-14.
`scripts/e2e/run-openrouter-live.sh` passed with **1 test, 0 failures,
11 assertions** in 40.10 seconds using the real OpenRouter key and production
instructions. The [coverage boundary](coverage-boundary.md) still applies.

The follow-up also exposed two test-isolation errors: global HTTP mocks in
credential issuance/revoke tests intercepted unrelated online model inventory
requests. One recorded an unexpected catalog request; the other consumed the
intended first-revoke 503 response during catalog discovery. These tests now
inject inventory through the existing discovery seam, retaining all original
authentication and retry assertions. Do not disable production discovery or
weaken those assertions to accommodate the mocks.

Oracle reviewed the follow-up diff with no blockers; this does not constitute
review of the entire recovered checkpoint. Catalog refresh still deliberately
forces revalidation and has a five-second network deadline, so an online cold
start can incur that delay even when a cached catalog exists.
