import type { WeeklyReportPresentationInput } from "./weekly-report-presentation.server";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function markdownToHtml(markdown: string | undefined): string {
  const lines = (markdown ?? "").trim().split(/\r?\n/);
  if (!markdown?.trim()) return '<p class="muted">暂无内容</p>';
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      out.push(`<ul>${list.join("")}</ul>`);
      list = [];
    }
  };
  for (const line of lines) {
    const value = line.trim();
    if (!value) {
      flush();
      continue;
    }
    const heading = value.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      flush();
      out.push(`<h3>${escapeHtml(heading[1]!)}</h3>`);
      continue;
    }
    const bullet = value.match(/^[-*+]\s+(.+)$/);
    if (bullet) {
      list.push(`<li>${escapeHtml(bullet[1]!)}</li>`);
      continue;
    }
    flush();
    out.push(`<p>${escapeHtml(value)}</p>`);
  }
  flush();
  return out.join("");
}

function anchor(value: string, index: number): string {
  return `section-${index}-${value.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/** A self-contained, readable HTML export inspired by the supplied MetaRSI article template. */
export function buildWeeklyReportHtml(input: WeeklyReportPresentationInput): string {
  const sections: Array<{ heading: string; text: string }> = [];
  if (input.summary?.trim()) sections.push({ heading: "Team Summary", text: input.summary });
  for (const member of input.members) {
    for (const [name, markdown] of Object.entries(member.sections)) {
      if (markdown?.trim())
        sections.push({ heading: `${member.displayName} · ${name}`, text: markdown });
    }
  }
  const toc = sections
    .map((section, index) => {
      const id = anchor(section.heading, index);
      return `<a href="#${id}">${escapeHtml(section.heading)}</a>`;
    })
    .join("");
  const body = sections
    .map((section, index) => {
      const id = anchor(section.heading, index);
      return `<section id="${id}"><div class="eyebrow">${String(index + 1).padStart(2, "0")}</div><h2>${escapeHtml(section.heading)}</h2><div class="prose">${markdownToHtml(section.text)}</div></section>`;
    })
    .join("");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f2f3f7;--panel:#fff;--ink:#1b1d2a;--ink2:#4b4f63;--muted:#7c8096;--line:#d6d9e3;--accent:#5b4bc4;--soft:#e6e2f8;--shadow:0 8px 24px #1b1d2a0f} @media(prefers-color-scheme:dark){:root{--bg:#14161f;--panel:#1f2230;--ink:#ecedf3;--ink2:#b4b7c7;--muted:#7e8299;--line:#2e3242;--accent:#a79bf0;--soft:#2a2748;--shadow:0 8px 24px #0006}}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.85 system-ui,-apple-system,"Noto Sans SC","Microsoft YaHei",sans-serif}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}.page{display:grid;grid-template-columns:210px minmax(0,980px);gap:48px;max-width:1280px;margin:auto;padding:0 24px 96px}@media(max-width:900px){.page{display:block}}nav{position:sticky;top:24px;align-self:start;padding-top:92px}@media(max-width:900px){nav{display:none}}nav a{display:block;padding:5px 12px;border-left:2px solid var(--line);color:var(--ink2);font-size:13px}nav a:hover{border-left-color:var(--accent)}main{min-width:0}header{padding:80px 0 42px;border-bottom:1px solid var(--line)}.eyebrow{font:12px/1.4 ui-monospace,SFMono-Regular,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}h1,h2,h3{font-family:Georgia,"Noto Serif SC",serif;line-height:1.3}h1{font-size:clamp(34px,5vw,54px);margin:0;letter-spacing:-.02em}h2{font-size:28px;margin:0 0 14px}h3{font-size:20px;margin:22px 0 8px}.sub{max-width:720px;color:var(--ink2);font-size:18px;margin:18px 0}.meta{display:flex;flex-wrap:wrap;gap:8px 22px;color:var(--muted);font:13px ui-monospace,SFMono-Regular,monospace}.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:26px 28px;margin-top:38px}.card p:last-child,.prose p:last-child{margin-bottom:0}section{margin-top:72px;scroll-margin-top:24px}.prose{max-width:760px;color:var(--ink2)}.prose p{margin:0 0 14px}.prose ul{margin:0 0 16px;padding-left:1.4em}.prose li{margin:5px 0}.muted{color:var(--muted)}footer{margin-top:72px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}@media print{body{background:#fff;color:#111}.page{display:block;max-width:980px}nav{display:none}.card{box-shadow:none}section{break-inside:avoid}}
</style></head><body><div class="page"><nav aria-label="目录">${toc}</nav><main><header><div class="eyebrow">Weekly Report · ${escapeHtml(input.period)}</div><h1>${escapeHtml(input.title)}</h1><p class="sub">成员工作总结、团队重点与后续事项</p><div class="meta"><span>Sections <b>${sections.length}</b></span><span>Members <b>${input.members.length}</b></span></div></header><div class="card"><div class="eyebrow">TL;DR</div><div class="prose">${markdownToHtml(input.summary ?? "")}</div></div>${body}<footer>Generated by CoForge Weekly Report Assistant · ${escapeHtml(input.period)}</footer></main></div></body></html>`;
}
