# Diagnoses established during recovery

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
