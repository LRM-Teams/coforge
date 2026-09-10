import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { AgentSkillsScope, RuntimeProvider } from "@coforge/protocol";
import { agentEnvironment } from "./environment";

type Root = { path: string; label: string; legacy?: "commands" | "pi" };
const MAX_FILE_BYTES = 262_144;

/** Directory observation only. Does not load/execute resources or alter a session. */
export async function listAgentSkills(options: {
  provider: RuntimeProvider;
  agentWorkspaceDirectory: string;
  environment?: Readonly<Record<string, string>>;
}): Promise<{ global: AgentSkillsScope; workspace: AgentSkillsScope }> {
  const env = agentEnvironment(options.environment);
  const cwd = resolve(options.agentWorkspaceDirectory);
  const home = env.HOME;
  const local = (path: string, legacy?: Root["legacy"]): Root => ({
    path: join(cwd, path),
    label: path,
    legacy,
  });
  const personal = (path: string, legacy?: Root["legacy"]): Root => ({
    path: resolve(home!, path),
    label: `~/${path}`,
    legacy,
  });
  const native = (
    variable: string,
    fallback: string,
    suffix: string,
    legacy?: Root["legacy"],
  ): Root =>
    env[variable]
      ? { path: resolve(cwd, env[variable]!, suffix), label: `$${variable}/${suffix}`, legacy }
      : personal(`${fallback}/${suffix}`, legacy);
  let globals: Root[] = [],
    locals: Root[];
  switch (options.provider) {
    case "claude-code":
      locals = [local(".claude/skills"), local(".claude/commands", "commands")];
      if (home)
        globals = [
          native("CLAUDE_CONFIG_DIR", ".claude", "skills"),
          native("CLAUDE_CONFIG_DIR", ".claude", "commands", "commands"),
        ];
      break;
    case "codex":
      locals = [local(".agents/skills"), local(".codex/skills")];
      if (home)
        globals = [
          personal(".agents/skills"),
          native("CODEX_HOME", ".codex", "skills"),
          native("CODEX_HOME", ".codex", "skills/.system"),
          { path: "/etc/codex/skills", label: "$SYSTEM_CODEX_SKILLS" },
        ];
      break;
    case "kiro":
      locals = [local(".kiro/skills")];
      if (home) globals = [native("KIRO_HOME", ".kiro", "skills")];
      break;
    case "pi":
      locals = [local(".pi/skills", "pi"), local(".agents/skills")];
      if (home)
        globals = [
          native("PI_CODING_AGENT_DIR", ".pi/agent", "skills", "pi"),
          personal(".agents/skills"),
        ];
      break;
    case "coforge":
      locals = [local(".pi/skills", "pi"), local(".agents/skills")];
      break;
  }
  const deadline = Date.now() + 3_000;
  return {
    global:
      options.provider === "coforge" || !home
        ? { status: "unsupported", entries: [], directories: [] }
        : await scan(globals, deadline),
    workspace: await scan(locals, deadline),
  };
}

async function scan(roots: Root[], deadline: number): Promise<AgentSkillsScope> {
  const result: AgentSkillsScope = { status: "ok", entries: [], directories: [] };
  let visited = 0;
  for (const root of roots) {
    const directory: AgentSkillsScope["directories"][number] = {
      path: root.label,
      status: "scanned",
    };
    result.directories.push(directory);
    try {
      // Roots and workspace ancestors must not redirect the query elsewhere.
      // This is not an OS sandbox or protection against concurrent same-user rename.
      if ((await realpath(root.path)) !== resolve(root.path)) {
        directory.status = "unsupported";
        result.status = "partial";
        continue;
      }
      const seen = new Set<string>();
      await walk(root.path, 0);
      async function walk(path: string, depth: number): Promise<void> {
        if (
          ++visited > 2_048 ||
          depth > 8 ||
          result.entries.length >= 256 ||
          Date.now() > deadline
        ) {
          result.status = "partial";
          return;
        }
        const canonical = await realpath(path);
        const fromRoot = relative(root.path, canonical);
        if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || seen.has(canonical)) {
          result.status = "partial";
          return;
        }
        seen.add(canonical);
        const info = await lstat(canonical);
        if (info.isDirectory()) {
          const handle = await opendir(canonical);
          for await (const child of handle) {
            if (visited > 2_048 || result.entries.length >= 256 || Date.now() > deadline) {
              result.status = "partial";
              break;
            }
            if (child.name.startsWith(".")) continue;
            try {
              await walk(join(path, child.name), depth + 1);
            } catch {
              result.status = "partial";
            }
          }
        } else if (
          info.isFile() &&
          (basename(path) === "SKILL.md" ||
            ((root.legacy === "commands" || (root.legacy === "pi" && depth === 1)) &&
              path.endsWith(".md")))
        ) {
          const sourcePath = `${root.label}/${relative(root.path, path).split(sep).join("/")}`;
          if (sourcePath.length > 512) {
            result.status = "partial";
            return;
          }
          const file = await open(
            canonical,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Invalid skill file");
            const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
            const { bytesRead } = await file.read(buffer);
            if (bytesRead > MAX_FILE_BYTES) throw new Error("Skill file too large");
            const content = buffer.toString("utf8", 0, bytesRead).replaceAll("\r\n", "\n");
            const header = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
            if (!header && root.legacy !== "commands") throw new Error("Missing skill metadata");
            const metadata: unknown = header ? Bun.YAML.parse(header[1]!) : {};
            if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
              throw new Error("Invalid metadata");
            const name =
              Reflect.get(metadata, "name") ??
              (basename(path) === "SKILL.md"
                ? basename(resolve(path, ".."))
                : basename(path, ".md"));
            const description = Reflect.get(metadata, "description") ?? "";
            if (
              typeof name !== "string" ||
              !name.trim() ||
              name.length > 128 ||
              typeof description !== "string" ||
              description.trim().length > 512 ||
              // oxlint-disable-next-line no-control-regex -- Do not publish terminal control bytes.
              /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(name + description)
            )
              throw new Error("Invalid metadata fields");
            result.entries.push({ name: name.trim(), description: description.trim(), sourcePath });
          } finally {
            await file.close();
          }
        }
      }
    } catch (error) {
      directory.status =
        error && typeof error === "object" && Reflect.get(error, "code") === "ENOENT"
          ? "missing"
          : "unreadable";
      if (directory.status !== "missing") result.status = "partial";
    }
  }
  result.entries.sort(
    (a, b) => a.name.localeCompare(b.name) || a.sourcePath.localeCompare(b.sourcePath),
  );
  return result;
}
