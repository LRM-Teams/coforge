# Required rebuild and restart sequence

Any change to Daemon, Computer, CLI, SDK, or Web code must be built before a
real E2E run. Do not run the test against an older installed binary, generated
bundle, or already-running service. Use this order:

1. Build every affected package and generated artifact.
2. Restart every E2E service or process that loads those artifacts.
3. Verify the expected version or endpoint responds from the restarted process.
4. Run the real E2E test and inspect both its final business assertion and the
   service-side diagnostics.

Never build concurrently with an E2E run that uses the same output directory.
Compilation success alone is not evidence that the running Agent or Daemon
loaded the new code.

The test uses production Agent instructions and OpenRouter model
`deepseek/deepseek-v4.1-flash`. Success requires canonical Agent replies in
PostgreSQL, not just model completion or a delivery ACK. It checks ordinary
channel replies, muted-channel suppression, personal mention bypass, and
followed-thread delivery and replies in the correct thread.
