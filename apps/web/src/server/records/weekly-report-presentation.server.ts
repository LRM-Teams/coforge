import { unzipSync, zipSync } from "fflate";
import template from "./templates/foundation-models-weekly.json";

export type WeeklyReportPresentationMember = {
  displayName: string;
  sections: Record<string, string | undefined>;
};

export type WeeklyReportPresentationInput = {
  title: string;
  period: string;
  summary?: string;
  members: readonly WeeklyReportPresentationMember[];
};

function encodeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Conservative pagination keeps long reports readable and retains all text. */
function pages(markdown: string): string[] {
  const text = markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "• ")
    .trim();
  const characters = Array.from(text);
  const result: string[] = [];
  let page = "";
  let lines = 0;
  for (const char of characters) {
    page += char;
    if (char === "\n") lines++;
    if (page.length >= 700 || lines >= 14) {
      result.push(page);
      page = "";
      lines = 0;
    }
  }
  if (page) result.push(page);
  return result.length ? result : ["—"];
}

/** Builds a presentation from the blank source theme; no historical report data is copied. */
export async function buildWeeklyReportPresentation(
  input: WeeklyReportPresentationInput,
): Promise<Uint8Array> {
  const files = unzipSync(Uint8Array.fromBase64(template.base64));
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const bodyTemplate = decoder.decode(files["ppt/slides/slide2.xml"]);
  const slideRelations = files["ppt/slides/_rels/slide2.xml.rels"];
  const cover = decoder
    .decode(files["ppt/slides/slide1.xml"])
    .replace("{{title}}", () => encodeXml(input.title))
    .replace("{{period}}", () => encodeXml(input.period));
  files["ppt/slides/slide1.xml"] = encoder.encode(cover);
  delete files["ppt/slides/slide2.xml"];
  delete files["ppt/slides/_rels/slide2.xml.rels"];
  const sections: { heading: string; text: string }[] = [];
  if (input.summary?.trim()) sections.push({ heading: "Team Summary", text: input.summary });
  for (const member of input.members) {
    for (const [name, markdown] of Object.entries(member.sections)) {
      if (markdown?.trim())
        sections.push({ heading: `${member.displayName} · ${name}`, text: markdown });
    }
  }
  let count = 1;
  for (const section of sections) {
    const contentPages = pages(section.text);
    for (const [index, body] of contentPages.entries()) {
      count++;
      const heading =
        section.heading + (contentPages.length > 1 ? ` (${index + 1}/${contentPages.length})` : "");
      const paragraphs = body
        .split("\n")
        .map(
          (line) =>
            `<a:p><a:r><a:rPr lang="en-US" sz="1800"/><a:t>${encodeXml(line)}</a:t></a:r></a:p>`,
        )
        .join("");
      const xml = bodyTemplate
        .replace("{{heading}}", () => encodeXml(heading))
        .replace(/<a:p>(?:(?!<a:p>)[\s\S])*?\{\{body\}\}[\s\S]*?<\/a:p>/, () => paragraphs);
      files[`ppt/slides/slide${count}.xml`] = encoder.encode(xml);
      files[`ppt/slides/_rels/slide${count}.xml.rels`] = slideRelations;
    }
  }
  const ids = Array.from({ length: count }, (_, i) => i + 1);
  files["ppt/presentation.xml"] = encoder.encode(
    decoder
      .decode(files["ppt/presentation.xml"])
      .replace(
        /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
        `<p:sldIdLst>${ids.map((id) => `<p:sldId id="${255 + id}" r:id="weeklySlide${id}"/>`).join("")}</p:sldIdLst>`,
      ),
  );
  // Template relationship XML uses namespace prefixes produced by normalization.
  const relPath = "ppt/_rels/presentation.xml.rels";
  let rels = decoder.decode(files[relPath]);
  rels = rels.replace(/<\w*:Relationship\b[^>]*Type="[^"]*\/slide"[^>]*\/>/g, "");
  const prefix = rels.match(/<(\w+:)?Relationships\b/)?.[1] ?? "";
  files[relPath] = encoder.encode(
    rels.replace(
      `</${prefix}Relationships>`,
      ids
        .map(
          (id) =>
            `<${prefix}Relationship Id="weeklySlide${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${id}.xml"/>`,
        )
        .join("") + `</${prefix}Relationships>`,
    ),
  );
  let types = decoder.decode(files["[Content_Types].xml"]);
  const typePrefix = types.match(/<(\w+:)?Types\b/)?.[1] ?? "";
  types = types.replace(
    /<(?:\w+:)?Override\b[^>]*PartName="\/ppt\/slides\/slide\d+\.xml"[^>]*\/>/g,
    "",
  );
  files["[Content_Types].xml"] = encoder.encode(
    types.replace(
      `</${typePrefix}Types>`,
      ids
        .map(
          (id) =>
            `<${typePrefix}Override PartName="/ppt/slides/slide${id}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
        )
        .join("") + `</${typePrefix}Types>`,
    ),
  );
  return zipSync(files);
}
