/**
 * File-card markdown helpers (ported from Multica, CDN-domain legacy matching
 * simplified — only `!file[name](url)` is rewritten without a CDN allowlist).
 */

export const FILE_CARD_URL_PATTERN = /\/uploads\/[^)]*|https?:\/\/[^)]+/;

export function isAllowedFileCardHref(href: string): boolean {
  return /^(https?:\/\/|\/uploads\/|data:)/i.test(href);
}

const NEW_FILE_CARD_RE = new RegExp(
  `^!file\\[((?:\\\\.|[^\\]])*)\\]\\((${FILE_CARD_URL_PATTERN.source})\\)$`,
);

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function toFileCardHtml(filename: string, url: string): string {
  return `<div data-type="fileCard" data-href="${escapeAttr(url)}" data-filename="${escapeAttr(filename)}"></div>`;
}

/** Convert `!file[name](url)` lines into HTML divs TipTap can parse. */
export function preprocessFileCards(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      const newMatch = trimmed.match(NEW_FILE_CARD_RE);
      if (newMatch) {
        const filename = newMatch[1]!.replace(/\\([[\]\\()])/g, "$1");
        return toFileCardHtml(filename, newMatch[2]!);
      }
      return line;
    })
    .join("\n");
}
