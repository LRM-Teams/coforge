# coforge-agent

`@coforge/agent` is CoForge's built-in code-agent runtime. It runs as an
independent resident child process of `coforge-daemon` and currently uses the
official Pi SDK.

The package owns Pi-specific SDK setup, extensions, and skills. It is bundled
with the Daemon release and is not installed directly by users.

The package can be packed and installed independently:

```bash
bun run check
bun test
bun run pack:check
```

Installing it provides the `coforge-agent` executable. The runner finishes Pi
resource discovery, including `.agents/skills` from its working directory and
ancestors, before accepting JSONL commands on stdin.
