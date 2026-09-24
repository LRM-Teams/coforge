# Live OpenRouter integration test

Run `scripts/e2e/run-openrouter-live.sh` from an Amp orb with the repository's
E2E services and a real `OPENROUTER_API_KEY` supplied through the environment.
The runner starts the declared services and reads their generated credentials.
Never replace the caller's key with a diagnostic placeholder, print credentials,
or claim a real model call based only on credential presence.

## Contents

- [Required rebuild and restart sequence](rebuild-and-restart.md): The build, restart, and verify order required before any real E2E run, and what the OpenRouter test asserts.
- [Coverage boundary](coverage-boundary.md): What the in-process OpenRouter Daemon test covers and what it does not.
- [Diagnoses established during recovery](recovery-diagnoses.md): Diagnoses established while recovering the live test, and shortcuts that must never satisfy a failed stage.
- [Recovery verification](recovery-verification.md): Checkpoint and follow-up verification results from 2026-09-14, including the test-isolation fixes.
- [Native setup investigation](native-setup-investigation.md): Why the first native Computer setup attempt failed and the harness prerequisites it revealed.
- [Native Linux verification and repeatable setup](native-linux-setup.md): The verified native Linux procedure and the repeatable `run-computer-setup.sh` harness.
- [Native browser scenario coverage](native-browser-scenario.md): Attachment, Task review/Done, Agent-created Task, and reassignment phases of the native browser scenario.
- [Native CLI fix and HTTPS setup migration](native-https-migration.md): The attachment-metadata CLI defect, the HTTPS setup migration, and the runs that verified or failed it.
- [Native run guidance](native-run-guidance.md): Build ordering, offline recovery, selectors, the hydration defect, and environment restart rules for native runs.
