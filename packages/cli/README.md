# `coforge` Agent-facing CLI

This binary is the stable command boundary exposed to code agents. Message
transport is intentionally injected by the eventual host; the standalone
binary currently reports a clear unavailable-transport error.
