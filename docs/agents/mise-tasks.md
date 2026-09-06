# Mise tasks

Read and follow this guidance before adding, changing, or removing a mise task.
It defines CoForge's task ownership rules; it does not claim that mise or its
community imposes a universal allowlist.

## Source basis

The official mise documentation describes tasks as project commands for
building, testing, linting, deploying, running servers, and everyday
development. It supports both short or detailed TOML declarations and
standalone executable file tasks:

- [Tasks](https://mise.jdx.dev/tasks/)
- [TOML-based tasks](https://mise.jdx.dev/tasks/toml-tasks.html)
- [File tasks](https://mise.jdx.dev/tasks/file-tasks.html)
- [Running tasks](https://mise.jdx.dev/tasks/running-tasks.html)
- [Monorepo tasks](https://mise.jdx.dev/tasks/monorepo.html)
- [Continuous integration](https://mise.jdx.dev/continuous-integration.html)

The official docs define supported mechanisms rather than deciding ownership
for every repository. Public repositories maintained by the mise author show a
recurring practice, not a binding community standard: mise itself keeps
repository orchestration in
[tasks.toml](https://github.com/jdx/mise/blob/main/tasks.toml), delegates
package-native commands to
[package.json](https://github.com/jdx/mise/blob/main/package.json), and uses
executable files for substantial procedural tasks. The
[hk task directory](https://github.com/jdx/hk/tree/main/mise-tasks) follows the
same executable-file pattern. CoForge adopts that division explicitly below.

## Admission rule

Add or retain a root mise task only when at least one condition is true:

1. It is a documented developer command or reusable repository quality,
   development, verification, or release entry point.
2. It coordinates multiple workspaces, languages, tools, or ordered steps.
3. It needs mise-owned features such as pinned tools, task environment,
   working directory, dependencies, confirmation, sources, or outputs.

A one-command wrapper is valid when it intentionally provides a stable
repository entry point. Being short does not make a task redundant; lacking a
repository-level consumer or mise-specific responsibility does.

Do not add a mise task for:

- a one-off maintenance command or private convenience alias;
- a package-internal helper used only by another package script;
- every `package.json` script merely to make it available through mise;
- a CI-only wrapper that merely forwards to an existing package script;
- GitHub Actions permissions, matrices, hosted-runner setup, secrets, caches,
  artifact handling, or other CI-provider behavior.

## Ownership

- Keep package-owned operations in that workspace's `package.json`, including
  native `dev`, `test`, `build`, `format`, `lint`, `typecheck`, generation, and
  database commands.
- Expose a focused package operation through mise only when it independently
  satisfies the admission rule; appearing as a separate CI step is not enough.
- Give each operation one implementation owner. A mise task may delegate to a
  package script or executable repository script, but must not copy its
  procedural logic. Do not add a root `package.json` script whose only purpose
  is to forward to a mise task.
- CI workflows own provider infrastructure and may call the same mise tasks
  used locally. They do not need to hide their job graph behind one monolithic
  task.

## Form and naming

- Keep one command, a short command sequence, and declarative task metadata in
  `mise.toml`.
- Put non-trivial branching, loops, cleanup, argument processing, or
  platform-specific behavior in a checked executable under `scripts/`. If the
  repository later adopts a mise file-task directory, the same rule applies.
- Use plain verbs such as `test`, `check`, `build`, and `setup` for repository
  entry points. Use colon groups such as `test:web` and `check:daemon` for
  focused variants.
- Give every directly invokable task a description. Hide a genuinely internal
  dependency task instead of advertising it in the public task list.
- Use `mise run <task>` in documentation and automation. Official guidance
  warns that the shorter `mise <task>` form can later collide with a mise
  command.
- Reserve `mise install` for installing tools. Name repository dependency or
  bootstrap work `mise run setup`, not `mise run install`.
- Do not enable experimental monorepo task inference merely to avoid explicit
  ownership decisions. Adopt it only in a focused change after checking the
  current official stability and migration guidance.

## Review questions

Before accepting a task change, answer:

1. Who invokes this task directly: a developer, documentation, or a CI job?
2. Why is the package script or executable script alone insufficient?
3. Where is the operation implemented, and is that the only implementation?
4. Does its name fit the repository verbs and colon-group convention?
5. Does `mise tasks` describe the public task clearly without exposing internal
   helper steps?
