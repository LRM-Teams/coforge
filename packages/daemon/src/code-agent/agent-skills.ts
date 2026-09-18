import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  RUNTIME_PROVIDER,
  type AgentSkillsScope,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
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
    case RUNTIME_PROVIDER.CLAUDE_CODE:
      locals = [local(".claude/skills"), local(".claude/commands", "commands")];
      if (home)
        globals = [
          native("CLAUDE_CONFIG_DIR", ".claude", "skills"),
          native("CLAUDE_CONFIG_DIR", ".claude", "commands", "commands"),
        ];
      break;
    case RUNTIME_PROVIDER.CODEX:
      locals = [local(".agents/skills"), local(".codex/skills")];
      if (home)
        globals = [
          personal(".agents/skills"),
          native("CODEX_HOME", ".codex", "skills"),
          native("CODEX_HOME", ".codex", "skills/.system"),
          { path: "/etc/codex/skills", label: "$SYSTEM_CODEX_SKILLS" },
        ];
      break;
    case RUNTIME_PROVIDER.KIRO:
      locals = [local(".kiro/skills")];
      if (home) globals = [native("KIRO_HOME", ".kiro", "skills")];
      break;
    case RUNTIME_PROVIDER.PI:
      locals = [local(".pi/skills", "pi"), local(".agents/skills")];
      if (home)
        globals = [
          native("PI_CODING_AGENT_DIR", ".pi/agent", "skills", "pi"),
          personal(".agents/skills"),
        ];
      break;
    case RUNTIME_PROVIDER.COFORGE:
      locals = [local(".pi/skills", "pi"), local(".agents/skills")];
      break;
    default: {
      const unreachable: never = options.provider;
      throw new Error(`Unhandled runtime provider: ${unreachable}`);
    }
  }
  const deadline = Date.now() + 3_000;
  return {
    global:
      options.provider === RUNTIME_PROVIDER.COFORGE || !home
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
          // The containing scan directory, not the per-file path: the UI groups entries by it
          // (ADR 0045).
          const sourcePath = root.label;
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
            // `name` is always the skill directory name (or the flat command file's basename),
            // never the frontmatter `name`, so the `/name` badge always matches a real path.
            const name =
              basename(path) === "SKILL.md" ? basename(resolve(path, "..")) : basename(path, ".md");
            const frontmatterName = Reflect.get(metadata, "name");
            const displayName =
              typeof frontmatterName === "string" && frontmatterName.trim()
                ? frontmatterName.trim()
                : name;
            const description = Reflect.get(metadata, "description") ?? "";
            const userInvocableRaw = Reflect.get(metadata, "user-invocable");
            const userInvocable = userInvocableRaw === true || userInvocableRaw === "true";
            if (
              !name.trim() ||
              name.length > 128 ||
              !displayName.trim() ||
              displayName.length > 128 ||
              typeof description !== "string" ||
              description.trim().length > 512 ||
              // oxlint-disable-next-line no-control-regex -- Do not publish terminal control bytes.
              /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(name + displayName + description)
            )
              throw new Error("Invalid metadata fields");
            result.entries.push({
              name: name.trim(),
              displayName: displayName.trim(),
              description: description.trim(),
              userInvocable,
              sourcePath,
            });
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
  // Deduplicate by `name` within this scope: the first root/entry found wins (ADR 0045).
  // Global and Workspace are separate scopes and are not deduplicated against each other.
  const seen = new Map<string, (typeof result.entries)[number]>();
  for (const entry of result.entries) if (!seen.has(entry.name)) seen.set(entry.name, entry);
  result.entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  return result;
}
