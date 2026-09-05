# Testing

Read and follow this guidance when writing or modifying tests, investigating
test failures, or reviewing test changes. Apply the sections relevant to the task.
It supplements the existing `tdd` workflow; it does not require unrelated tasks
to add tests or run stress checks.

## General principles

- Test observable behavior through the owning module's public contract rather than private implementation details.
- For bug fixes, first demonstrate the failure with a regression test, then make the smallest implementation change that passes it. Follow the existing `tdd` guidance for behavioral changes.
- Keep assertions specific to the behavior under test. A test should fail when that behavior breaks, not pass because unrelated output happens to contain the expected value.
- Distinguish production defects, incorrect test assumptions, and environment failures using evidence before changing code or expectations. Preserve valid assertions and report unresolved failures honestly.

## Async and concurrent tests

- Wait for observable completion through the public contract: a returned Promise, status event, or acknowledgement. Do not use `sleep`, timer ticks, or arbitrary microtask flushing as proof that unrelated async work has completed. Time-based behavior may use controlled clocks or real timers when the clock itself is under test.
- Assert only ordering guaranteed by the product contract. When operations become concurrent, revisit existing ordering assertions; verify required per-Agent ordering and eventual completion without assuming a global completion order.
- Use controllable Promises at existing external boundaries to force slow operations and relevant interleavings. Release gates and clean up runtimes in `finally`, including when assertions fail. Do not expose private implementation solely for test synchronization.

## Investigating intermittent failures

- Retain the failing command and output, construct a controlled reproduction, and determine whether the defect is in production behavior or test synchronization. A passing rerun is diagnostic evidence, not a fix; do not mask failures with retries, skipped tests, longer timeouts, or weaker valid assertions.
- For concurrency changes and flaky-test fixes, run bounded repetitions of the affected tests in addition to the normal checks. Record the command, repetition count, and failures in the CR; for example, `mise exec -- bun test <test-file> --test-name-pattern '<affected tests>' --rerun-each 100`. Repetitions supplement controlled interleavings, not replace them; do not repeat the entire suite in every CI run by default.

## Review

- An independent reviewer must check which public behavior each test protects and whether breaking that behavior would make the test fail. For async/concurrent tests, also ask: "What observable completion does this test await?" and "Which contract guarantees each asserted ordering?"
- If a test is changed instead of production code, require evidence that its previous assumption was invalid and that the intended behavior remains covered. Unexplained intermittent failures must not be reported as verified or ready to merge; escalation must preserve the failing evidence rather than silently defer it.
