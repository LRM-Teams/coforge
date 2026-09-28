# Coverage boundary

This is a Daemon integration test, not native Computer installation/setup E2E.
It invokes registration/message application modules, starts DaemonRuntime
in-process, and injects a Pi Provider and a limited inventory. WSS, Agent
sessions, OpenRouter inference, message persistence, and delivery ACKs are real.
Native Computer setup, process supervision, and complete inventory publication
are verified separately in the [native procedure](native-linux-setup.md). Do not advertise the
in-process OpenRouter test as covering them.
