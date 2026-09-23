import { RUNTIME_PROVIDER, type AgentContextReport } from "@lrm/coforge-sdk/internal";
import { AgentContextReportTimeoutError } from "#src/code-agent/contract";
import { claudeCliEnvironment, runClaudeCli } from "./process";

/**
 * Reads a one-shot breakdown of the Agent's current Claude Code context-window composition (ADR
 * 0051): `claude -p "/context" --output-format json --resume <sessionId>`, against the Agent's
 * own already-running session — verified empirically (Claude Code 2.1.276, 2026-09-18) to work
 * headless, read the session transcript on disk with no model call, in roughly 6 seconds. This is
 * not documented `-p` behavior (the headless docs list only `/model`, `/effort`, `/fast`,
 * `/color`, `/rename`, `/mcp`, `/config`, `/output-style`); treat it as undocumented, hence the
 * strict `local_command`/`subtype` gate below and the `unparsed` fallback for anything else.
 */
export async function readClaudeCodeContextReport(options: {
  command?: readonly string[];
  workingDirectory: string;
  sessionId: string;
  environment?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}): Promise<AgentContextReport | undefined> {
  const baseCommand = options.command ?? ["claude"];
  const timeoutMs = options.timeoutMs ?? 20_000;
  const environment = claudeCliEnvironment(options.environment);
  const result = await runClaudeCli(
    [...baseCommand, "-p", "/context", "--output-format", "json", "--resume", options.sessionId],
    options.workingDirectory,
    environment,
    timeoutMs,
  );
  if (result.timedOut) throw new AgentContextReportTimeoutError();
  if (result.exitCode !== 0) return undefined;
  let envelope: unknown;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  if (!envelope || typeof envelope !== "object") return undefined;
  const record = envelope as Record<string, unknown>;
  // Confirms the reply came from the local `/context` command, not a model turn (the CLI would
  // otherwise happily "answer" a misspelled or future-removed slash command as a chat message).
  if (record.local_command !== true || record.subtype !== "success") return undefined;
  if (typeof record.result !== "string") return undefined;
  return parseClaudeContextReport(record.result);
}

type MarkdownTable = { heading: string | undefined; header: string[]; rows: string[][] };

/**
 * Parses one Claude Code `/context` Markdown report into the SDK's `AgentContextReport`. Pure and
 * synchronous: no filesystem or process access, so it is fully unit-testable against a fixture.
 * Recognizes only the header line (`**Tokens:** used / window`), the first table in the document
 * (the category breakdown — column order and extra columns beyond the recognized ones are
 * tolerated), and, if present, tables headed `### Memory Files` / `### Skills`. Everything else —
 * unknown sections, extra columns — is ignored rather than rejected. Returns `undefined` on any
 * parse failure (the caller's `unparsed` state is the safety net; there is no partial result).
 */
export function parseClaudeContextReport(
  markdown: string,
  observedAt: string = new Date().toISOString(),
): AgentContextReport | undefined {
  const modelMatch = /\*\*Model:\*\*\s*(.+)/i.exec(markdown);
  const tokensMatch = /\*\*Tokens:\*\*\s*(\S+)\s*\/\s*(\S+)/i.exec(markdown);
  if (!tokensMatch) return undefined;
  const used = parseTokenCount(tokensMatch[1]!);
  const window = parseTokenCount(tokensMatch[2]!.replace(/[),]+$/, ""));
  if (!used || !window) return undefined;

  const tables = findTables(markdown);
  if (tables.length === 0) return undefined;
  const categories = parseCategoryTable(tables[0]!);
  if (!categories || categories.length === 0) return undefined;

  const memoryTable = tables.find(
    (table) => table.heading && /memory\s+files/i.test(table.heading),
  );
  const skillsTable = tables.find(
    (table) => table.heading && /^skills$/i.test(table.heading ?? ""),
  );

  return {
    provider: RUNTIME_PROVIDER.CLAUDE_CODE,
    ...(modelMatch ? { model: modelMatch[1]!.trim() } : {}),
    usedTokens: used.tokens,
    windowTokens: window.tokens,
    observedAt,
    categories,
    ...(memoryTable ? { memoryFiles: parseMemoryFilesTable(memoryTable) } : {}),
    ...(skillsTable ? { skills: parseSkillsTable(skillsTable) } : {}),
  };
}

function parseCategoryTable(
  table: MarkdownTable,
): { name: string; tokens: number; approximate?: boolean }[] | undefined {
  const tokensIndex = table.header.findIndex((header) => /token/i.test(header));
  if (tokensIndex === -1) return undefined;
  const rows = table.rows
    .map((row) => {
      const name = row[0]?.trim();
      const parsed = row[tokensIndex] ? parseTokenCount(row[tokensIndex]) : undefined;
      if (!name || !parsed) return undefined;
      return { name, tokens: parsed.tokens, ...(parsed.approximate ? { approximate: true } : {}) };
    })
    .filter((row): row is { name: string; tokens: number; approximate?: boolean } => Boolean(row));
  return rows;
}

function parseMemoryFilesTable(
  table: MarkdownTable,
): { kind: string; path: string; tokens: number; approximate?: boolean }[] | undefined {
  const kindIndex = table.header.findIndex((header) => /type/i.test(header));
  const pathIndex = table.header.findIndex((header) => /path/i.test(header));
  const tokensIndex = table.header.findIndex((header) => /token/i.test(header));
  if (kindIndex === -1 || pathIndex === -1 || tokensIndex === -1) return undefined;
  const rows = table.rows
    .map((row) => {
      const kind = row[kindIndex]?.trim();
      const path = row[pathIndex]?.trim();
      const parsed = row[tokensIndex] ? parseTokenCount(row[tokensIndex]) : undefined;
      if (!kind || !path || !parsed) return undefined;
      return {
        kind,
        path,
        tokens: parsed.tokens,
        ...(parsed.approximate ? { approximate: true } : {}),
      };
    })
    .filter((row): row is { kind: string; path: string; tokens: number; approximate?: boolean } =>
      Boolean(row),
    );
  return rows.length ? rows : undefined;
}

function parseSkillsTable(
  table: MarkdownTable,
): { name: string; source: string; tokens: number; approximate?: boolean }[] | undefined {
  const nameIndex = table.header.findIndex((header) => /skill/i.test(header));
  const sourceIndex = table.header.findIndex((header) => /source/i.test(header));
  const tokensIndex = table.header.findIndex((header) => /token/i.test(header));
  if (nameIndex === -1 || sourceIndex === -1 || tokensIndex === -1) return undefined;
  const rows = table.rows
    .map((row) => {
      const name = row[nameIndex]?.trim();
      const source = row[sourceIndex]?.trim();
      const parsed = row[tokensIndex] ? parseTokenCount(row[tokensIndex]) : undefined;
      if (!name || !source || !parsed) return undefined;
      return {
        name,
        source,
        tokens: parsed.tokens,
        ...(parsed.approximate ? { approximate: true } : {}),
      };
    })
    .filter((row): row is { name: string; source: string; tokens: number; approximate?: boolean } =>
      Boolean(row),
    );
  return rows.length ? rows : undefined;
}

/**
 * Parses one token-count cell: `24.9k` / `2k` (`k` -> x1000, one decimal), `151` (plain), `~220`
 * (approximation marker stripped, no flag — only the `< N` form sets `approximate`), `< 20` (`< N`
 * -> `N` with `approximate: true`).
 */
function parseTokenCount(raw: string): { tokens: number; approximate?: boolean } | undefined {
  const trimmed = raw.trim();
  const lessThan = /^<\s*(.+)$/.exec(trimmed);
  const approximate = /^~\s*(.+)$/.exec(trimmed);
  const rest = (lessThan?.[1] ?? approximate?.[1] ?? trimmed).trim();
  const kilo = /^([\d]+(?:\.\d+)?)\s*k$/i.exec(rest);
  const plain = /^([\d]+(?:\.\d+)?)$/.exec(rest);
  const numeric = kilo ? Number(kilo[1]) * 1000 : plain ? Number(plain[1]) : undefined;
  if (numeric === undefined || !Number.isFinite(numeric)) return undefined;
  return { tokens: Math.round(numeric), ...(lessThan ? { approximate: true } : {}) };
}

function findTables(markdown: string): MarkdownTable[] {
  const lines = markdown.split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  let heading: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(lines[index]!);
    if (headingMatch) {
      heading = headingMatch[1];
      continue;
    }
    const header = parseTableRow(lines[index]!);
    const separator = index + 1 < lines.length ? lines[index + 1] : undefined;
    if (!header || separator === undefined || !isSeparatorRow(separator)) continue;
    const rows: string[][] = [];
    let cursor = index + 2;
    while (cursor < lines.length) {
      const row = parseTableRow(lines[cursor]!);
      if (!row) break;
      rows.push(row);
      cursor++;
    }
    tables.push({ heading, header, rows });
    index = cursor - 1;
  }
  return tables;
}

function parseTableRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return undefined;
  const withoutEdges = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return withoutEdges.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(line: string): boolean {
  const row = parseTableRow(line);
  return Boolean(row && row.length > 0 && row.every((cell) => /^:?-+:?$/.test(cell)));
}
