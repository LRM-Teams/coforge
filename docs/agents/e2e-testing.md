# Live OpenRouter integration test

Run `scripts/e2e/run-openrouter-live.sh` from an Amp orb with the repository's
E2E services and a real `OPENROUTER_API_KEY` supplied through the environment.
The runner starts the declared services and reads their generated credentials.
Never replace the caller's key with a diagnostic placeholder, print credentials,
or claim a real model call based only on credential presence.

The test uses production Agent instructions and OpenRouter model
`deepseek/deepseek-v4.1-flash`. Success requires canonical Agent replies in
PostgreSQL, not just model completion or a delivery ACK. It checks ordinary
channel replies, muted-channel suppression, personal mention bypass, and
followed-thread delivery and replies in the correct thread.

## Coverage boundary

This is a Daemon integration test, not native Computer installation/setup E2E.
It invokes registration/message application modules, starts DaemonRuntime
in-process, and injects a Pi Provider and a limited inventory. WSS, Agent
sessions, OpenRouter inference, message persistence, and delivery ACKs are real.
Native Computer setup, process supervision, and complete inventory publication
remain separate required coverage. Do not advertise this test as covering them.

## Diagnoses established during recovery

- Pi's default model runtime creation does not enable network catalog refresh.
  A valid API key alone does not guarantee a newly released model is available.
  Use the SDK's supported catalog refresh, not a test-only model definition.
- A newly created Session can legitimately be empty. Waiting for a nonempty
  transcript before sending its first message deadlocks the test's ordering.
  Observe successful session creation, then send through the application seam.
- A muted root message is not automatically supplied as thread context. Put
  the requested test reply in the delivered thread message. Keep assertions for
  the destination thread, delivery ACK, and persisted reply.
- Never satisfy a failed stage by injecting ACKs, invoking a second Agent start,
  overriding production instructions, skipping authorization, or dropping the
  canonical reply assertion.
- Polling deadlines and failures must identify the awaited stage. Formatting
  and type checks do not establish E2E success.

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
instructions. The coverage boundary above still applies.

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
